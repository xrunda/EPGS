import { deriveReportSections } from './classify-sections';
import { parseClassifyReportVerdict } from './classify-parse';
import {
  buildClassifyReportUserPrompt,
  CLASSIFY_REPORT_SYSTEM_PROMPT,
} from './classify-prompt';
import {
  AttentionLevel,
  AttentionSemanticSnapshot,
  ClassifyReportErrorCode,
  ClassifyReportInput,
  ClassifyReportResult,
  CLASSIFY_REPORT_PROMPT_VERSION,
  DEFAULT_CLASSIFY_MAX_TOKENS,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_REPORT_MAX_CHARS,
  VerifiedClassifyEvidence,
  VerifiedClassifyMatch,
} from './classify-types';
import { SemanticError, classifyModelError } from './errors';
import { verifyEvidence } from './evidence';
import { canonicalJson, sha256Hex } from './hashing';
import type { SemanticModelClient } from './model-client';
import { SemanticTask } from './types';

/**
 * The Classify Report task (issue #88).
 *
 * One report in, one attempt out. The pipeline, in order, with the failure each
 * step can produce:
 *
 *  1. Assemble the report sections (检查项目 / 检查所见 / 诊断意见), omitting
 *     empty ones. All empty -> EMPTY_INPUT, no call.
 *  2. Refuse an over-long report -> REPORT_TOO_LONG, no call. Never truncated.
 *  3. Hash the input, the report and the configuration BEFORE the call, so a
 *     failure still records which input it failed on.
 *  4. Call the model. Timeout/transport/HTTP -> ERROR.
 *  5. Parse + strictly validate the reply. Garbage -> ERROR.
 *  6. Resolve every `semantic_id` against the configuration actually sent.
 *     An unknown id -> UNKNOWN_SEMANTIC, whole attempt fails (issue #88 §9).
 *  7. Verify EVERY evidence excerpt against the exact field text that was sent.
 *     One that cannot be located -> EVIDENCE_UNVERIFIED, whole attempt fails.
 *  8. Compute the level from the CONFIGURED colours and check the model's own
 *     claim against it. Disagreement -> INCOHERENT_LEVEL.
 *
 * WHY EVERY STEP FAILS THE WHOLE ATTEMPT rather than dropping just the bad
 * match (owner decision for #88): dropping a match would compute the level from
 * an incomplete set, and the result could come out LOWER than what the model
 * actually claimed. That is a silent under-report - the one direction this
 * system must never fail in. A failed attempt is visible in the audit table; a
 * quietly lowered level is not.
 *
 * ADDITIVE BY CONSTRUCTION. Nothing in this file can lower a level, remove a
 * keyword hit, or touch #87's state. On any failure the result carries
 * `attentionLevel: null` and `matches: []`, and the caller has nothing to
 * misread.
 *
 * NOTHING IN THIS FILE LOGS OR THROWS. A model failure is data (an audit row),
 * not an exception: patient monitoring must keep running when the model is
 * down, so there is no path here that can take the caller down with it.
 */

/** Everything the task needs. Assembled once per app, reused per call. */
export interface ClassifyReportDeps {
  /** The model seam. A fake in tests. */
  client: SemanticModelClient;
  /** Model identifier to send. */
  model: string;
  /** Overrides; each falls back to the documented default. */
  timeoutMs?: number;
  maxTokens?: number;
  /** Cap on the assembled report text; exceeding it skips the report. */
  reportMaxChars?: number;
  /** Prompt/contract version. Defaults to CLASSIFY_REPORT_PROMPT_VERSION. */
  taskVersion?: string;
  /** Sampling temperature. Defaults to 0 - a judging task wants determinism. */
  temperature?: number;
}

/**
 * The configured level of each match, reduced to the report's level.
 *
 * RED > YELLOW > GREEN, exactly as issue #88 §8 requires. Reads ONLY the
 * configuration-derived `attentionLevel` on each verified match - the model's
 * own `attention_level` is not an input to this function, which is what makes
 * "the model cannot set a level" true rather than merely intended.
 */
export function computeAttentionLevel(
  matches: readonly { attentionLevel: AttentionLevel }[],
): AttentionLevel | null {
  const priority: readonly AttentionLevel[] = ['RED', 'YELLOW', 'GREEN'];
  for (const level of priority) {
    if (matches.some((match) => match.attentionLevel === level)) {
      return level;
    }
  }
  return null;
}

/**
 * Locate one excerpt in the report fields the model was shown, in the order the
 * fields appear in the prompt.
 *
 * WHY EVERY FIELD IS TRIED: the model is deliberately NOT asked to say which
 * field an excerpt came from. Asking would add a field it can get wrong, and a
 * wrong field label would fail the whole attempt for no benefit - the excerpt
 * either exists in the text that was sent or it does not. When the same text
 * occurs in two fields the first one wins, which is deterministic and always
 * points at text that really exists; an auditor can always find it.
 */
function locateEvidence(
  excerpt: string,
  sections: readonly { field: VerifiedClassifyEvidence['field']; text: string }[],
): VerifiedClassifyEvidence | null {
  for (const section of sections) {
    // contextStart is 0: the whole field text is sent, never a window, so the
    // offsets returned are already in monitor_record's own coordinates.
    const verified = verifyEvidence(excerpt, section.text, 0);
    if (verified !== null) {
      return {
        field: section.field,
        hash: verified.hash,
        start: verified.start,
        end: verified.end,
      };
    }
  }
  return null;
}

/**
 * Run one Classify Report attempt. Never throws; every failure is a result.
 */
export async function classifyReport(
  input: ClassifyReportInput,
  deps: ClassifyReportDeps,
): Promise<ClassifyReportResult> {
  const task: SemanticTask = 'CLASSIFY_REPORT';
  const taskVersion = deps.taskVersion ?? CLASSIFY_REPORT_PROMPT_VERSION;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? DEFAULT_CLASSIFY_MAX_TOKENS;
  const reportMaxChars = deps.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS;
  const temperature = deps.temperature ?? 0;
  const model = deps.model;

  // Sorted by id so the presentation - and therefore every hash below - depends
  // on the CONFIGURATION, not on the order a caller happened to read rows in.
  const semantics: AttentionSemanticSnapshot[] = [...input.semantics].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const sections = deriveReportSections(input);

  // Hashes are computed even for an input that never reaches the model: the
  // audit row's shape is constant, so every attempt is described the same way.
  const reportHash = sha256Hex(
    canonicalJson({
      examItem: input.examItem ?? null,
      reportContent: input.reportContent ?? null,
      diagnosis: input.diagnosis ?? null,
    }),
  );
  const configHash = sha256Hex(
    canonicalJson(
      semantics.map((semantic) => ({
        id: semantic.id,
        version: semantic.version,
        attentionLevel: semantic.attentionLevel,
        name: semantic.name,
        description: semantic.description,
      })),
    ),
  );
  const inputHash = sha256Hex(
    canonicalJson({ task, taskVersion, model, reportHash, configHash }),
  );

  const base: Omit<ClassifyReportResult, 'outcome' | 'error'> = {
    task,
    taskVersion,
    model,
    modelVersion: null,
    latencyMs: null,
    attentionLevel: null,
    modelAttentionLevel: null,
    matches: [],
    semanticCount: semantics.length,
    inputHash,
    reportHash,
    configHash,
  };

  const fail = (error: ClassifyReportErrorCode): ClassifyReportResult => ({
    ...base,
    outcome: 'ERROR',
    error,
  });

  if (semantics.length === 0) {
    return fail('NO_SEMANTICS');
  }
  if (sections.length === 0) {
    return fail('EMPTY_INPUT');
  }

  const assembled = sections.reduce((total, section) => total + section.text.length, 0);
  if (assembled > reportMaxChars) {
    return fail('REPORT_TOO_LONG');
  }

  const userPrompt = buildClassifyReportUserPrompt(sections, semantics);

  let raw: string;
  let modelVersion: string | null;
  let latencyMs: number | null;

  try {
    const response = await deps.client.complete({
      system: CLASSIFY_REPORT_SYSTEM_PROMPT,
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
    return fail(classifyModelError(err));
  }

  const withCall: Omit<ClassifyReportResult, 'outcome' | 'error'> = {
    ...base,
    modelVersion,
    latencyMs,
  };

  const failCall = (error: ClassifyReportErrorCode): ClassifyReportResult => ({
    ...withCall,
    outcome: 'ERROR',
    error,
  });

  let verdict;
  try {
    verdict = parseClassifyReportVerdict(raw);
  } catch (err) {
    return failCall(err instanceof SemanticError ? err.code : 'SCHEMA_INVALID');
  }

  // Resolve every claimed id against the configuration that was actually sent.
  // An id the hospital never configured means the model is answering about
  // something else entirely, so nothing it produced is trustworthy (issue #88 §9).
  const byId = new Map(semantics.map((semantic) => [semantic.id, semantic]));
  for (const match of verdict.matches) {
    if (!byId.has(match.semanticId)) {
      return failCall('UNKNOWN_SEMANTIC');
    }
  }

  // Verify ALL evidence before accepting ANY of it. The loop deliberately does
  // not build the result as it goes: a partially-ground result must never exist,
  // not even transiently.
  const verifiedMatches: VerifiedClassifyMatch[] = [];
  for (let index = 0; index < verdict.matches.length; index += 1) {
    const match = verdict.matches[index];
    const semantic = byId.get(match.semanticId);
    if (semantic === undefined) {
      // Unreachable: the loop above already rejected unknown ids.
      return failCall('UNKNOWN_SEMANTIC');
    }

    const evidence: VerifiedClassifyEvidence[] = [];
    for (const excerpt of match.evidence) {
      const located = locateEvidence(excerpt, sections);
      if (located === null) {
        return failCall('EVIDENCE_UNVERIFIED');
      }
      evidence.push(located);
    }

    verifiedMatches.push({
      semanticId: semantic.id,
      semanticVersion: semantic.version,
      semanticName: semantic.name,
      // The CONFIGURED colour - not anything the model said. This single line is
      // what makes the model unable to set a level.
      attentionLevel: semantic.attentionLevel,
      confidence: match.confidence,
      reason: match.reason,
      ordinal: index,
      evidence,
    });
  }

  // The model states an overall level; the code decides it. A disagreement is
  // recorded as a failed attempt rather than resolved in the code's favour
  // silently, because a model that reasons about the wrong thing is worth
  // seeing: it means the prompt or the configuration is being misread.
  const computed = computeAttentionLevel(verifiedMatches);
  if (verdict.attentionLevel !== (computed ?? 'NONE')) {
    return failCall('INCOHERENT_LEVEL');
  }

  return {
    ...withCall,
    outcome: 'OK',
    error: null,
    attentionLevel: computed,
    modelAttentionLevel: verdict.attentionLevel,
    matches: verifiedMatches,
  };
}
