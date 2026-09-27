import { SemanticErrorCode } from './types';

/**
 * Framework-agnostic failure raised by anything in the semantic engine that
 * cannot complete its call: the model client (timeout, transport, HTTP) and
 * the response parser/validator (unparseable body, schema violation, unknown
 * enum). Each carries a machine-readable `code` which is what gets persisted
 * on the audit row and logged - never a raw response body.
 *
 * WHY A CARRIED CODE INSTEAD OF AN ERROR MESSAGE TO PARSE: the only thing
 * allowed to leave this package about a failure is the classified code. If
 * callers had to regex a message they would eventually log the message, and
 * the message of a model failure is model output, which may quote the report.
 * `message` here is a short, hand-written English description with no request
 * or response content in it, safe to log as-is.
 */
export class SemanticError extends Error {
  readonly code: SemanticErrorCode;

  constructor(code: SemanticErrorCode, message: string) {
    super(message);
    this.name = 'SemanticError';
    this.code = code;
  }
}

/** True when a model call exceeded its timeout and was aborted. */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: unknown }).name === 'AbortError' ||
      (err as { name?: unknown }).name === 'TimeoutError')
  );
}

/**
 * Classify anything thrown during a model call into a SemanticErrorCode.
 *
 * The default is MODEL_ERROR rather than a guess: mislabelling a transport
 * failure as, say, a timeout would quietly corrupt the very ratio the fail-open
 * reasons exist to measure. Anything already classified passes through
 * unchanged, so a parser error deeper in the stack keeps its specific code.
 */
export function classifyModelError(err: unknown): SemanticErrorCode {
  if (err instanceof SemanticError) {
    return err.code;
  }
  if (isAbortError(err)) {
    return 'TIMEOUT';
  }
  if (err instanceof TypeError) {
    // Node's fetch rejects a genuine transport failure (DNS, ECONNREFUSED,
    // socket reset) with a TypeError and a `cause`. A TypeError from our own
    // code would land here too, but nothing in the call path can throw one.
    return 'NETWORK';
  }
  return 'MODEL_ERROR';
}

/**
 * The fail-open decision reason matching a failure code, so the audit row
 * always answers "why was this kept" in the same vocabulary as the error.
 *
 * Exhaustive on purpose - a new SemanticErrorCode without a case here is a
 * compile error, which is how a new failure mode is forced to declare how it
 * fails open instead of silently defaulting to a generic reason.
 */
export function decisionReasonForError(
  code: SemanticErrorCode,
):
  | `EVIDENCE_UNVERIFIED_KEEP`
  | `TIMEOUT_KEEP`
  | `NETWORK_KEEP`
  | `HTTP_ERROR_KEEP`
  | `INVALID_JSON_KEEP`
  | `SCHEMA_INVALID_KEEP`
  | `UNKNOWN_ENUM_KEEP`
  | `EMPTY_CONTEXT_KEEP`
  | `MODEL_ERROR_KEEP` {
  if (code === 'EVIDENCE_UNVERIFIED') return 'EVIDENCE_UNVERIFIED_KEEP';
  if (code === 'TIMEOUT') return 'TIMEOUT_KEEP';
  if (code === 'NETWORK') return 'NETWORK_KEEP';
  if (code === 'INVALID_JSON') return 'INVALID_JSON_KEEP';
  if (code === 'SCHEMA_INVALID') return 'SCHEMA_INVALID_KEEP';
  if (code === 'UNKNOWN_ENUM') return 'UNKNOWN_ENUM_KEEP';
  if (code === 'EMPTY_CONTEXT') return 'EMPTY_CONTEXT_KEEP';
  if (code === 'MODEL_ERROR') return 'MODEL_ERROR_KEEP';
  // Everything left is the HTTP_<status> form. Landing here for an unknown
  // literal keeps the function total without a runtime lookup table.
  return 'HTTP_ERROR_KEEP';
}

/**
 * Strip anything from a would-be stored string that could smuggle report text
 * into a column that is not supposed to hold it, and bound its length.
 *
 * Used for the model's `reason`. The residual risk is documented on
 * `MonitorMatchSemantic.reason` in schema.prisma: a model MAY quote the report
 * inside its explanation, and we cannot prevent that without discarding the
 * explanation the issue requires. What we can do is keep it short, single-line,
 * and masked for callers without patientDetail rights - which the api adapter
 * does. This function does the short and single-line part.
 */
export function sanitizeReason(raw: string, maxLength: number): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
