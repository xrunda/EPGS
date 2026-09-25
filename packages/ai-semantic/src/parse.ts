import { SemanticError, sanitizeReason } from './errors';
import {
  MAX_REASON_LENGTH,
  SEMANTIC_CONFIDENCES,
  SEMANTIC_STATUSES,
  SemanticConfidence,
  SemanticStatus,
  ValidateMatchVerdict,
} from './types';

/**
 * Strict structured-output validation (issue #87).
 *
 * Two stages, in this order:
 *
 *  1. `extractJsonObject` - tolerantly find the JSON object in whatever the
 *     model produced. Models wrap JSON in ```json fences, prepend "好的，以下
 *     是结果：", or append an explanation. None of that means the judgement is
 *     wrong, so the braces are located and the object is taken; everything
 *     outside them is discarded.
 *
 *  2. `parseValidateMatchVerdict` - validate that object strictly. Missing
 *     field, wrong type, unknown enum member: all rejected. The tolerance is
 *     about ENVELOPE, never about CONTENT - a verdict we had to guess at would
 *     be worth less than no verdict, because it would look like a judgement.
 *
 * Every rejection is a `SemanticError` whose code the caller records and then
 * fails open on.
 */

/**
 * Extract the first balanced JSON object from a model reply.
 *
 * Brace counting is what makes this robust to trailing prose: a naive
 * `lastIndexOf('}')` would swallow an explanation that itself contains braces.
 * String literals are tracked so a brace inside a quoted value does not
 * confuse the depth count, and escapes are respected so `\"` does not end a
 * string early.
 *
 * Returns null when there is no balanced object - the caller reports
 * INVALID_JSON.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  // Unbalanced - an object that never closed. Truncated output, most likely
  // because maxTokens was hit mid-object.
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and strictly validate one model reply into a verdict.
 *
 * @throws SemanticError INVALID_JSON   no balanced object in the reply
 * @throws SemanticError SCHEMA_INVALID a required field is missing or mistyped
 * @throws SemanticError UNKNOWN_ENUM   an enum-shaped field is not a known member
 */
export function parseValidateMatchVerdict(raw: string): ValidateMatchVerdict {
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

  if (!isRecord(parsed)) {
    throw new SemanticError('SCHEMA_INVALID', 'model reply JSON was not an object');
  }

  const { matched, semantic_status: semanticStatus, confidence, reason, evidence } = parsed;
  const intentExcludesHistory = parsed.intent_excludes_history;

  if (typeof matched !== 'boolean') {
    throw new SemanticError('SCHEMA_INVALID', 'field "matched" is missing or not a boolean');
  }
  if (typeof semanticStatus !== 'string') {
    throw new SemanticError('SCHEMA_INVALID', 'field "semantic_status" is missing or not a string');
  }
  if (typeof confidence !== 'string') {
    throw new SemanticError('SCHEMA_INVALID', 'field "confidence" is missing or not a string');
  }
  if (typeof reason !== 'string') {
    throw new SemanticError('SCHEMA_INVALID', 'field "reason" is missing or not a string');
  }
  if (typeof evidence !== 'string') {
    throw new SemanticError('SCHEMA_INVALID', 'field "evidence" is missing or not a string');
  }
  if (typeof intentExcludesHistory !== 'boolean') {
    throw new SemanticError(
      'SCHEMA_INVALID',
      'field "intent_excludes_history" is missing or not a boolean',
    );
  }

  // Enum membership is checked AFTER type, and reported distinctly from a type
  // error. The two mean different things operationally: SCHEMA_INVALID is
  // usually a broken gateway, while UNKNOWN_ENUM is usually the model
  // inventing a category - and that is a signal about the prompt, not the
  // transport, so it is worth being able to count separately.
  if (!SEMANTIC_STATUSES.includes(semanticStatus as SemanticStatus)) {
    throw new SemanticError('UNKNOWN_ENUM', 'field "semantic_status" is not a known status');
  }
  if (!SEMANTIC_CONFIDENCES.includes(confidence as SemanticConfidence)) {
    throw new SemanticError('UNKNOWN_ENUM', 'field "confidence" is not a known confidence');
  }

  // `reason` is bounded and flattened here rather than at the storage layer, so
  // what the decision was made from and what is persisted are the same string.
  // An empty reason is allowed: it is cosmetic, and failing a judgement over it
  // would fail open on a technicality. The verdict fields are what matter.
  return {
    matched,
    semanticStatus: semanticStatus as SemanticStatus,
    confidence: confidence as SemanticConfidence,
    reason: sanitizeReason(reason, MAX_REASON_LENGTH),
    evidence,
    intentExcludesHistory,
  };
}
