import { Injectable, Logger } from '@nestjs/common';
import { FetchReportsParams, FetchReportsResult, PacsReportDto } from '@epgs/shared-types';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';

/** Hard ceiling on page size, mirrored from the #20 contract's `pageSize` max. */
export const MAX_PAGE_SIZE = 500;

/** Default per-request timeout when PACS_HTTP_TIMEOUT_MS is not set. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Options for constructing HttpPacsRisAdapter. Values are read from
 * environment variables by the DI provider (pacs-adapter.module.ts) -
 * never hardcoded, never logged (the token especially).
 */
export interface HttpPacsRisAdapterOptions {
  /** e.g. "https://internal-host/api/v1/endoscopy" - no trailing slash required. */
  baseUrl: string;
  /** Bearer service token. NEVER logged or included in thrown error messages. */
  serviceToken: string;
  /** Per-request timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable fetch implementation, for testing. Defaults to global fetch (Node 24 native). */
  fetchImpl?: typeof fetch;
}

/**
 * Raised when the #20 gateway responds with a definitive client-side
 * problem (401/403/404/400) that a retry cannot fix. The sync job should
 * record this clearly and move on rather than retrying indefinitely.
 */
export class PacsHttpAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PacsHttpAuthError';
  }
}

/**
 * Raised for transient/server-side failures (503 DATA_SOURCE_UNAVAILABLE,
 * 429 RATE_LIMITED, network errors, timeouts, 5xx). The sync job's
 * retry/backoff logic should catch this specifically and retry without
 * advancing the cursor.
 */
export class PacsHttpTransientError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PacsHttpTransientError';
  }
}

/**
 * Raised when the gateway returns a 200 but the response body does not
 * match the contracted shape (missing required field, wrong type, etc).
 * Distinct from PacsHttpTransientError because retrying an identical
 * request against a buggy/misconfigured gateway will not help - but it's
 * also not the caller's fault, so the sync job should record it and
 * fail the batch rather than silently skipping data.
 */
export class PacsHttpContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacsHttpContractError';
  }
}

/** Minimal shape of the #20 gateway's envelope, before payload validation. */
interface RawEnvelope {
  requestId?: unknown;
  serverTime?: unknown;
  data?: unknown;
  code?: unknown;
  message?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PacsHttpContractError(`PacsReport.${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new PacsHttpContractError(`PacsReport.${field} must be a string or null`);
  }
  return value;
}

/**
 * Combines the contract's `examDate` (date, required) and `examTime`
 * (time-of-day, optional) into a single UTC `Date` instant for the DTO.
 *
 * The source system's exam times are Asia/Shanghai wall-clock times; the
 * repo-wide convention is that `Date` objects hold UTC instants (see
 * apps/worker/src/sync/time-format.ts), so the wall-clock is interpreted
 * as UTC+08:00 (China has no DST) and normalized to the UTC instant.
 * A missing `examTime` is treated as 00:00:00 local.
 */
function combineExamDateTime(examDate: string, examTime: string | null): Date {
  const parsed = new Date(`${examDate}T${examTime ?? '00:00:00'}+08:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new PacsHttpContractError(`PacsReport.examDate/examTime is not a valid date-time`);
  }
  return parsed;
}

function requireDateText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PacsHttpContractError(`PacsReport.${field} must be a YYYY-MM-DD string`);
  }
  return value;
}

function nullableTimeText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value)) {
    throw new PacsHttpContractError(`PacsReport.${field} must be an HH:mm:ss time string or null`);
  }
  return value;
}

/**
 * Validates and maps one #20 `PacsReport` wire object to the internal
 * PacsReportDto. Per the read-only display contract (#28) the wire field
 * names match the DTO for the display fields; every field is still
 * explicitly validated rather than cast, because this payload crosses a
 * network/organizational boundary and a malformed single record must fail
 * loudly as a per-record error (caught by the sync job) instead of
 * poisoning downstream matching with `undefined`/`NaN`.
 *
 * Derivation note (issue #26): the gateway contract no longer provides
 * `reportId` or `sourceUpdatedAt` (see docs/api/pacs-ris-data-api.md §9).
 * They are internal sync bookkeeping only, so this mapper derives them as
 * `reportId = sourceRecordId` and `sourceUpdatedAt = examTime` (the
 * combined exam instant) - sufficient for idempotency/change-detection.
 */
export function mapWireReportToDto(raw: unknown): PacsReportDto {
  if (typeof raw !== 'object' || raw === null) {
    throw new PacsHttpContractError('PacsReport item is not an object');
  }
  const r = raw as Record<string, unknown>;
  const sourceRecordId = requireString(r.sourceRecordId, 'sourceRecordId');
  const examDate = requireDateText(r.examDate, 'examDate');
  const examTimeText = nullableTimeText(r.examTime, 'examTime');
  const examTime = combineExamDateTime(examDate, examTimeText);
  return {
    sourceRecordId,
    patientRegistrationNo: nullableString(r.patientRegistrationNo, 'patientRegistrationNo'),
    patientName: nullableString(r.patientName, 'patientName'),
    department: nullableString(r.department, 'department'),
    bedNo: nullableString(r.bedNo, 'bedNo'),
    patientTypeCode: nullableString(r.patientTypeCode, 'patientTypeCode'),
    patientTypeName: nullableString(r.patientTypeName, 'patientTypeName'),
    examItem: nullableString(r.examItem, 'examItem'),
    examDate,
    examTimeText,
    examTime,
    reportId: sourceRecordId,
    reportContent: nullableString(r.reportContent, 'reportContent'),
    diagnosis: nullableString(r.diagnosis, 'diagnosis'),
    sourceUpdatedAt: examTime,
  };
}

function generateRequestId(): string {
  // No crypto.randomUUID dependency assumption issues on Node 24, but
  // keep this local/tiny rather than pulling in a uuid dependency just
  // for this.
  return `epgs-worker-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toShanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/**
 * PacsRisAdapter implementation that calls the #24 IRIS database gateway
 * contract (docs/api/pacs-ris-data-api.md /
 * docs/api/pacs-ris-data-api.openapi.yaml) over HTTP.
 *
 * Uses Node's built-in `fetch` (native since Node 18, and this repo
 * targets Node >=24 per package.json engines) rather than adding a new
 * HTTP client dependency - AbortController gives us timeouts for free
 * and the response shape is simple enough that no wrapper library earns
 * its weight.
 *
 * Error handling contract (see PacsHttpAuthError / PacsHttpTransientError
 * / PacsHttpContractError above):
 * - 401/403/400/404 -> PacsHttpAuthError (not retryable by the sync job;
 *   record clearly, do not advance past this call within the batch).
 * - 429/503/5xx/network error/timeout -> PacsHttpTransientError
 *   (retryable by the sync job's backoff logic).
 * - 200 with a body that fails contract validation -> PacsHttpContractError
 *   propagated from mapWireReportToDto/parsing (also not retryable as-is).
 *
 * This adapter never logs the service token, `Authorization` header
 * value, or any patient-identifying field. Log lines are limited to
 * request metadata (URL path, status, requestId, page size, elapsed ms).
 */
@Injectable()
export class HttpPacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(HttpPacsRisAdapter.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpPacsRisAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.serviceToken = options.serviceToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!params.since) {
      throw new Error('fetchReports: params.since is required');
    }
    if (!params.pageSize || params.pageSize <= 0) {
      throw new Error('fetchReports: params.pageSize must be a positive integer');
    }
    if (params.deviceId) {
      throw new Error('fetchReports: deviceId is not available in the confirmed IRIS schema');
    }
    const pageSize = Math.min(params.pageSize, MAX_PAGE_SIZE);

    const url = new URL(`${this.baseUrl}/reports`);
    url.searchParams.set('dateFrom', toShanghaiDate(params.since));
    url.searchParams.set('dateTo', toShanghaiDate(params.until ?? new Date()));
    if (params.department) {
      url.searchParams.set('department', params.department);
    }
    if (params.cursor) {
      url.searchParams.set('cursor', params.cursor);
    }
    url.searchParams.set('pageSize', String(pageSize));

    const requestId = generateRequestId();
    const startedAt = Date.now();
    const body = await this.request(url, requestId);
    const elapsedMs = Date.now() - startedAt;

    const data = body.data as { items?: unknown; nextCursor?: unknown } | undefined;
    if (!data || !Array.isArray(data.items)) {
      throw new PacsHttpContractError('PacsReportPage.data.items missing or not an array');
    }

    const items = data.items.map(mapWireReportToDto);
    const nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : undefined;

    this.logger.debug(
      `fetchReports ok requestId=${requestId} items=${items.length} elapsedMs=${elapsedMs} hasNextCursor=${Boolean(nextCursor)}`,
    );

    return { items, nextCursor };
  }

  /**
   * Executes one GET request against `url`, handling timeout, JSON
   * parsing, and HTTP-status-to-exception mapping. Never includes the
   * bearer token or full response body in thrown error messages -
   * only status/code/requestId, which are non-sensitive per
   * docs/api/pacs-ris-data-api.md section 4.4's error shape.
   */
  private async request(url: URL, requestId: string): Promise<RawEnvelope> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          'X-Request-Id': requestId,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? `PACS/RIS gateway request timed out after ${this.timeoutMs}ms`
        : `PACS/RIS gateway request failed: ${err instanceof Error ? err.message : 'unknown network error'}`;
      this.logger.warn(`fetchReports network error requestId=${requestId}: ${message}`);
      throw new PacsHttpTransientError(null, isAbort ? 'TIMEOUT' : 'NETWORK_ERROR', message);
    } finally {
      clearTimeout(timeout);
    }

    let parsed: RawEnvelope;
    try {
      parsed = (await response.json()) as RawEnvelope;
    } catch {
      if (!response.ok) {
        // Body wasn't JSON (e.g. an upstream proxy error page) - still
        // classify by status so retry behavior is correct.
        throw this.errorForStatus(response.status, 'NON_JSON_ERROR_BODY', requestId);
      }
      throw new PacsHttpContractError(
        `PACS/RIS gateway returned non-JSON 200 body (requestId=${requestId})`,
      );
    }

    if (response.ok) {
      return parsed;
    }

    const code = typeof parsed.code === 'string' ? parsed.code : 'UNKNOWN_ERROR';
    throw this.errorForStatus(response.status, code, requestId);
  }

  private errorForStatus(status: number, code: string, requestId: string): Error {
    // 401/403: bad or insufficient service credentials. 400/404: this
    // adapter's own request is malformed or references a nonexistent
    // report - not something a retry fixes. None of these should be
    // retried by the sync job's backoff loop.
    if (status === 401 || status === 403 || status === 400 || status === 404) {
      this.logger.warn(
        `fetchReports auth/client error requestId=${requestId} status=${status} code=${code}`,
      );
      return new PacsHttpAuthError(
        status,
        code,
        `PACS/RIS gateway rejected request: ${status} ${code}`,
      );
    }
    // 429/503/5xx: transient - the sync job's retry/backoff should
    // handle these without advancing its cursor.
    this.logger.warn(
      `fetchReports transient error requestId=${requestId} status=${status} code=${code}`,
    );
    return new PacsHttpTransientError(
      status,
      code,
      `PACS/RIS gateway transient error: ${status} ${code}`,
    );
  }
}
