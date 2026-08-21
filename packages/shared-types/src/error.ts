/**
 * Unified error response shape returned by apps/api's global exception filter.
 */
export interface ApiErrorBody {
  error: {
    /** Machine-readable error code, e.g. "INTERNAL_ERROR", "NOT_FOUND". */
    code: string;
    /** Human-readable message. Must never contain secrets or stack traces. */
    message: string;
    /** Correlation ID propagated via the x-correlation-id header, for tracing. */
    correlationId: string;
  };
}
