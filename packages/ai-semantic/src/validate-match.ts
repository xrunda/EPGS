import type { MatchMode } from '@epgs/matching-engine';
import { buildContextWindow } from './context';
import { decideDisposition, keepOpen } from './disposition';
import { SemanticError, classifyModelError, decisionReasonForError } from './errors';
import { verifyEvidence } from './evidence';
import { canonicalJson, sha256Hex } from './hashing';
import {
  buildValidateMatchUserPrompt,
  fieldLabelFor,
  VALIDATE_MATCH_SYSTEM_PROMPT,
} from './prompt';
import { parseValidateMatchVerdict } from './parse';
import type { SemanticModelClient } from './model-client';
import {
  DEFAULT_CONTEXT_CHAR_BUDGET,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  PROMPT_VERSION,
  SemanticTask,
  ValidateMatchInput,
  ValidateMatchResult,
} from './types';

/**
 * The Validate Match task (issue #87).
 *
 * One hit in, one attempt out. The pipeline, in order, with the failure each
 * step can produce and what it does about it:
 *
 *  1. Build the context window (anchor sentence + every sibling occurrence's
 *     sentence). Empty/unanchored -> EMPTY_CONTEXT, no call, fail open.
 *  2. Hash the input and the context. Do this BEFORE the call so a failure
 *     still records which input it failed on.
 *  3. Call the model. Timeout/transport/HTTP -> fail open.
 *  4. Parse + strictly validate the reply. Garbage -> fail open.
 *  5. Verify the evidence against the context actually sent. Not locatable ->
 *     fail open (the verdict is discarded entirely - see below).
 *  6. Decide the disposition. Pure code, no model input beyond the verdict.
 *
 * FAIL-OPEN IS STRUCTURAL, NOT A SET OF CATCH BLOCKS: every failure path
 * produces `outcome: 'ERROR'` with a `decision` whose `filtered` is false. The
 * function has no branch that can turn an error into a filter, and
 * `decideDisposition` is the only source of `filtered: true`. A caller cannot
 * accidentally filter on failure because there is nothing to accidentally
 * read - `verdict` is null and `decision.filtered` is false.
 *
 * WHY A FAILED EVIDENCE CHECK DISCARDS THE WHOLE VERDICT: the verdict's
 * justification could not be found in the text it claims to describe. We
 * cannot tell whether the status is also wrong, so the honest record is "the
 * call succeeded but its answer could not be checked" - not a half-trusted
 * verdict with a caveat. `error` and `decision.reason` say exactly that.
 *
 * NOTHING IN THIS FILE LOGS OR THROWS. A model failure is data (an audit row
 * and a decision), not an exception: patient monitoring must keep running when
 * the model is down, so there is no path here that can take the caller down
 * with it.
 */

/** Everything the task needs. Assembled once per app, reused per call. */
export interface ValidateMatchDeps {
  /** The model seam. A fake in tests. */
  client: SemanticModelClient;
  /** Model identifier to send. */
  model: string;
  /** Overrides; each falls back to the documented default. */
  timeoutMs?: number;
  maxTokens?: number;
  contextCharBudget?: number;
  /** Prompt/contract version. Defaults to PROMPT_VERSION. */
  taskVersion?: string;
  /** Sampling temperature. Defaults to 0 - a judging task wants determinism. */
  temperature?: number;
}

/**
 * Run one Validate Match attempt. Never throws; every failure is a result.
 */
export async function validateMatch(
  input: ValidateMatchInput,
  deps: ValidateMatchDeps,
): Promise<ValidateMatchResult> {
  const task: SemanticTask = 'VALIDATE_MATCH';
  const taskVersion = deps.taskVersion ?? PROMPT_VERSION;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = deps.temperature ?? 0;
  const contextCharBudget = deps.contextCharBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  const model = deps.model;

  const context = buildContextWindow({
    fieldText: input.fieldText,
    matchStart: input.matchStart,
    matchEnd: input.matchEnd,
    siblingOccurrences: input.siblingOccurrences,
    keyword: input.keyword,
    matchMode: input.matchMode as MatchMode | undefined,
    caseSensitive: input.caseSensitive ?? false,
    charBudget: contextCharBudget,
  });

  // Hashes are computed even for an empty context: the audit row's shape is
  // constant, so every attempt - successful or not - is described the same way.
  const userPrompt = buildValidateMatchUserPrompt({
    keyword: input.keyword,
    semanticIntent: input.semanticIntent,
    contextText: context.text,
    fieldLabel: fieldLabelFor(input.matchField),
  });

  const inputHash = sha256Hex(
    canonicalJson({
      task,
      taskVersion,
      model,
      keyword: input.keyword,
      semanticIntent: input.semanticIntent,
      matchField: input.matchField ?? null,
      matchMode: input.matchMode ?? null,
      reportVersion: input.reportVersion ?? null,
      matchStart: input.matchStart,
      matchEnd: input.matchEnd,
      contextStart: context.start,
      contextEnd: context.end,
      contextText: context.text,
    }),
  );
  const contextHash = sha256Hex(context.text);

  const base = {
    task,
    taskVersion,
    model,
    context,
    inputHash,
    contextHash,
  } as const;

  if (context.text.length === 0) {
    return {
      ...base,
      outcome: 'ERROR',
      modelVersion: null,
      latencyMs: null,
      error: 'EMPTY_CONTEXT',
      verdict: null,
      evidence: null,
      decision: keepOpen(decisionReasonForError('EMPTY_CONTEXT')),
    };
  }

  let raw: string;
  let modelVersion: string | null;
  let latencyMs: number | null;

  try {
    const response = await deps.client.complete({
      system: VALIDATE_MATCH_SYSTEM_PROMPT,
      user: userPrompt,
      model,
      temperature,
      maxTokens,
      timeoutMs,
    });
    raw = response.raw;
    modelVersion = response.modelVersion;
    latencyMs = response.latencyMs;
  } catch (err) {
    const code = classifyModelError(err);
    return {
      ...base,
      outcome: 'ERROR',
      modelVersion: null,
      latencyMs: null,
      error: code,
      verdict: null,
      evidence: null,
      decision: keepOpen(decisionReasonForError(code)),
    };
  }

  let verdict;
  try {
    verdict = parseValidateMatchVerdict(raw);
  } catch (err) {
    const code = err instanceof SemanticError ? err.code : 'SCHEMA_INVALID';
    return {
      ...base,
      outcome: 'ERROR',
      modelVersion,
      latencyMs,
      error: code,
      verdict: null,
      evidence: null,
      decision: keepOpen(decisionReasonForError(code)),
    };
  }

  // Evidence is checked against the SAME string that was sent - `context.text`,
  // not the field text - so a model cannot quote from a part of the report it
  // was never shown and have that count as grounding.
  const verified = verifyEvidence(verdict.evidence, context.text, context.start);
  if (verified === null) {
    return {
      ...base,
      outcome: 'ERROR',
      modelVersion,
      latencyMs,
      error: 'EVIDENCE_UNVERIFIED',
      verdict: null,
      evidence: null,
      decision: keepOpen(decisionReasonForError('EVIDENCE_UNVERIFIED')),
    };
  }

  return {
    ...base,
    outcome: 'OK',
    modelVersion,
    latencyMs,
    error: null,
    verdict,
    evidence: verified,
    decision: decideDisposition(verdict),
  };
}
