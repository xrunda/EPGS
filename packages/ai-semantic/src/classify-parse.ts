import { SemanticError, sanitizeReason } from './errors';
import { extractJsonObject } from './parse';
import {
  ATTENTION_LEVELS_OR_NONE,
  AttentionLevelOrNone,
  ClassifyReportMatch,
  ClassifyReportVerdict,
  MAX_CLASSIFY_REASON_LENGTH,
  MAX_EVIDENCE_LENGTH,
  MAX_EVIDENCE_PER_MATCH,
} from './classify-types';
import { SEMANTIC_CONFIDENCES, SemanticConfidence } from './types';

/**
 * Strict structured-output validation for Classify Report (issue #88).
 *
 * Same two stages as #87's parser, and the same principle:
 *
 *  1. `extractJsonObject` (shared) tolerantly locates the JSON object in
 *     whatever the model produced - fences, a polite preamble, a trailing
 *     explanation are all fine. Tolerance is about ENVELOPE.
 *
 *  2. `parseClassifyReportVerdict` validates that object strictly. Tolerance is
 *     never about CONTENT: a result we had to guess at is worth less than no
 *     result, because it would look like a finding.
 *
 * STRICTER THAN #87 ON PURPOSE, per the owner's decision for #88: any violation
 * fails the WHOLE attempt rather than degrading to a partial result. A model
 * that grounds one match in real text and fabricates another must not leave the
 * real one standing, because the report's level would then be computed from an
 * incomplete set and could come out LOWER than the model actually claimed - a
 * silent under-report, which is the worst direction to fail in. Everything here
 * therefore throws, and the caller writes an ERROR audit row with zero matches.
 *
 * WHICH CODE FOR WHICH VIOLATION:
 *   no JSON object / unparseable        -> INVALID_JSON
 *   missing or mistyped field           -> SCHEMA_INVALID
 *   evidence array missing/empty/too
 *   many/with a non-string or an
 *   over-long entry, or a duplicate
 *   semantic_id                         -> SCHEMA_INVALID  (the reply does not
 *                                          meet the output contract; the owner's
 *                                          "evidence 违反约束" case)
 *   attention_level / confidence not a
 *     known member                      -> UNKNOWN_ENUM
 *
 * UNKNOWN_ENUM is deliberately kept distinct from SCHEMA_INVALID: a mistyped
 * field is usually a broken gateway, while an invented enum member is usually
 * the model, and that is a signal about the prompt rather than the transport.
 *
 * NOTE: "the model named a semantic_id we did not send" is NOT detected here -
 * this function has no configuration to check against. The caller resolves ids
 * against the snapshot it actually sent and reports UNKNOWN_SEMANTIC.
 */
export function parseClassifyReportVerdict(raw: string): ClassifyReportVerdict {
  const json = extractJsonObject(raw);
  if (json === null) {
    throw new SemanticError('INVALID_JSON', 'model reply contained no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SemanticError('INVALID_JSON', 'model reply JSON object did not parse');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SemanticError('SCHEMA_INVALID', 'model reply JSON was not an object');
  }

  const source = parsed as Record<string, unknown>;
  const level = source.attention_level;
  const rawMatches = source.matches;

  if (typeof level !== 'string') {
    throw new SemanticError('SCHEMA_INVALID', 'field "attention_level" is missing or not a string');
  }
  if (!ATTENTION_LEVELS_OR_NONE.includes(level as AttentionLevelOrNone)) {
    throw new SemanticError('UNKNOWN_ENUM', 'field "attention_level" is not a known level');
  }
  if (!Array.isArray(rawMatches)) {
    throw new SemanticError('SCHEMA_INVALID', 'field "matches" is missing or not an array');
  }

  const seen = new Set<string>();
  const matches: ClassifyReportMatch[] = [];

  for (const entry of rawMatches) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SemanticError('SCHEMA_INVALID', 'a "matches" entry was not an object');
    }
    const item = entry as Record<string, unknown>;

    const semanticId = item.semantic_id;
    const reason = item.reason;
    const confidence = item.confidence;
    const evidence = item.evidence;

    if (typeof semanticId !== 'string' || semanticId.trim().length === 0) {
      throw new SemanticError('SCHEMA_INVALID', 'a match "semantic_id" is missing or empty');
    }
    if (typeof reason !== 'string') {
      throw new SemanticError('SCHEMA_INVALID', 'a match "reason" is missing or not a string');
    }
    if (typeof confidence !== 'string') {
      throw new SemanticError('SCHEMA_INVALID', 'a match "confidence" is missing or not a string');
    }
    if (!SEMANTIC_CONFIDENCES.includes(confidence as SemanticConfidence)) {
      throw new SemanticError('UNKNOWN_ENUM', 'a match "confidence" is not a known confidence');
    }
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new SemanticError(
        'SCHEMA_INVALID',
        'a match "evidence" is missing, not an array, or empty',
      );
    }
    if (evidence.length > MAX_EVIDENCE_PER_MATCH) {
      throw new SemanticError('SCHEMA_INVALID', 'a match carried too many evidence excerpts');
    }

    const excerpts: string[] = [];
    for (const excerpt of evidence) {
      if (typeof excerpt !== 'string' || excerpt.trim().length === 0) {
        throw new SemanticError('SCHEMA_INVALID', 'a match carried an empty evidence excerpt');
      }
      // An over-long excerpt is rejected rather than trimmed: quoting the whole
      // report proves nothing, and silently shortening it would leave the audit
      // trail describing an excerpt the model never produced.
      if (excerpt.length > MAX_EVIDENCE_LENGTH) {
        throw new SemanticError('SCHEMA_INVALID', 'a match carried an over-long evidence excerpt');
      }
      excerpts.push(excerpt);
    }

    // Duplicates are rejected rather than merged: the model listing one semantic
    // twice means it is not answering the question that was asked, and the
    // "one row per (attempt, semantic)" storage contract would break.
    const id = semanticId.trim();
    if (seen.has(id)) {
      throw new SemanticError('SCHEMA_INVALID', 'the reply named the same semantic_id twice');
    }
    seen.add(id);

    matches.push({
      semanticId: id,
      reason: sanitizeReason(reason, MAX_CLASSIFY_REASON_LENGTH),
      confidence: confidence as SemanticConfidence,
      evidence: excerpts,
    });
  }

  return { attentionLevel: level as AttentionLevelOrNone, matches };
}
