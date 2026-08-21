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
    /**
     * Optional machine-readable extra context for a specific error code,
     * e.g. `{ conflictingRuleId: '...' }` for RULE_CONFLICT (issue #4).
     * Callers must never put patient data or secrets here.
     */
    details?: Record<string, unknown>;
  };
}
