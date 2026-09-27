import { createHash } from 'crypto';

/**
 * Content hashing for the audit trail (issue #87).
 *
 * The owner decided (2026-09-25) that the text sent to the model must not be
 * persisted. The audit requirement did not go away with that decision - it
 * moved into hashes plus offsets. So the audit row answers "which input
 * produced this verdict" by storing a digest of the input, and an auditor who
 * is entitled to read the report body recomputes the same digest from it and
 * compares. Nothing about the text itself is recoverable from a hash, which is
 * the point.
 *
 * sha256 hex, matching the VARCHAR(64) columns in monitor_match_semantic.
 */

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * Required for `inputHash` to mean anything: two calls with the same logical
 * input must hash identically, and JS object key order is insertion order, so
 * building the same object in a different order (or after a refactor of the
 * call site) would otherwise silently produce a different hash for the same
 * judgement. Arrays keep their order - it is meaningful.
 *
 * `undefined` values are dropped (matching JSON.stringify), so an optional
 * field being absent and being explicitly undefined hash the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        out[key] = canonicalize(source[key]);
      }
    }
    return out;
  }
  return value;
}
