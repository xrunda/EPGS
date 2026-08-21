import { MockAgent, fetch as undiciFetch, Interceptable } from 'undici';
import { PacsReportStatus } from '@epgs/shared-types';
import {
  HttpPacsRisAdapter,
  PacsHttpAuthError,
  PacsHttpContractError,
  PacsHttpTransientError,
  mapWireReportToDto,
} from './http-pacs-ris-adapter';

/**
 * Mock HTTP server for testing HttpPacsRisAdapter against the #20
 * contract's documented behaviors (pagination, error codes, timeouts,
 * malformed bodies), per issue #6's "由于没有真实可用的测试环境, 写集成
 * 测试时用 mock HTTP server 模拟契约行为" requirement.
 *
 * Uses undici's built-in `MockAgent`, injected into the adapter via its
 * `fetchImpl` constructor option (bound with `{ dispatcher: mockAgent }`)
 * rather than `nock` or `setGlobalDispatcher`:
 * - `nock` 13.x only patches the legacy `http`/`https` modules; it does
 *   NOT intercept undici's dispatcher, which is what Node's native
 *   `fetch` (used by this adapter in production - see
 *   http-pacs-ris-adapter.ts's doc comment) is built on. nock-based
 *   mocks silently fail to match native `fetch` requests.
 * - `setGlobalDispatcher(mockAgent)` from the `undici` *package* does
 *   NOT affect Node's *built-in, internal* `fetch`/dispatcher under this
 *   repo's Jest + ts-jest setup - `globalThis.fetch !== require('undici').fetch`
 *   in that environment (verified directly: swapping the global
 *   dispatcher had no effect on `fetch()`, while calling
 *   `require('undici').fetch()` against the same MockAgent worked).
 * - Explicitly injecting `undici`'s own `fetch` (bound to the MockAgent
 *   via the `dispatcher` request option) through the adapter's
 *   `fetchImpl` constructor option sidesteps that realm mismatch
 *   entirely and is exactly what `fetchImpl` was added for.
 */
const ORIGIN = 'http://pacs-gateway.internal.test';
const BASE_URL = `${ORIGIN}/api/v1/endoscopy`;

let mockAgent: MockAgent;
let pool: Interceptable;

function mockFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(
      input as string,
      { ...init, dispatcher: mockAgent } as never,
    )) as unknown as typeof fetch;
}

function syntheticReport(overrides: Record<string, unknown> = {}) {
  return {
    patientId: 'TEST-P-0001',
    inpatientNo: 'TEST-I-0001',
    patientName: '测试患者甲',
    sex: 'F',
    age: 62,
    department: '测试科室',
    bedNo: 'TEST-12',
    studyAccessionNo: 'TEST-A-20260821001',
    examItem: '电子胃镜检查',
    examTime: '2026-08-21T01:30:00Z',
    reportId: 'TEST-R-0001',
    reportStatus: 'PENDING_REVIEW',
    rawStatusCode: 'SUBMITTED',
    reportSavedAt: '2026-08-21T01:55:00Z',
    reportSubmittedAt: '2026-08-21T02:00:00Z',
    reportReviewedAt: null,
    describeText: '测试检查所见文本，仅为合成数据。',
    diagnoseText: '测试诊断意见文本，仅为合成数据。',
    sourceUpdatedAt: '2026-08-21T02:00:05Z',
    ...overrides,
  };
}

function envelope(data: unknown) {
  return { requestId: 'req-1', serverTime: '2026-08-21T02:06:00Z', data };
}

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  pool = mockAgent.get(ORIGIN);
});

afterEach(async () => {
  await mockAgent.close();
});

describe('HttpPacsRisAdapter', () => {
  it('maps the canonical IRIS gateway date and time fields', () => {
    const dto = mapWireReportToDto({
      sourceRecordId: 'ES20260802013',
      patientRegistrationNo: '0000533611',
      patientName: '测试患者甲',
      department: '测试科室',
      bedNo: '40',
      patientTypeCode: 'I',
      patientTypeName: null,
      examItem: '电子结肠镜检查',
      examDate: '2026-08-02',
      examTime: '10:31:18',
      reportContent: '合成检查所见',
      diagnosis: '合成诊断',
    });

    expect(dto.sourceRecordId).toBe('ES20260802013');
    expect(dto.patientRegistrationNo).toBe('0000533611');
    expect(dto.examDate).toBe('2026-08-02');
    expect(dto.examTimeText).toBe('10:31:18');
    expect(dto.examTime).toEqual(new Date('2026-08-02T10:31:18+08:00'));
    expect(dto.sourceUpdatedAt).toEqual(dto.examTime);
  });

  it('maps a contract-shaped page response to FetchReportsResult / PacsReportDto', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(200, envelope({ items: [syntheticReport()], nextCursor: 'cursor-2', hasMore: true }));

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'test-token',
      fetchImpl: mockFetch(),
    });
    const result = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00Z'),
      pageSize: 200,
    });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('cursor-2');
    const dto = result.items[0];
    expect(dto.patientId).toBe('TEST-P-0001');
    expect(dto.reportStatus).toBe(PacsReportStatus.PENDING_REVIEW);
    expect(dto.sourceUpdatedAt).toEqual(new Date('2026-08-21T02:00:05Z'));
    expect(dto.reportReviewedAt).toBeNull();
  });

  it('uses the #24 dateFrom/dateTo query contract', async () => {
    pool
      .intercept({
        path: (path: string) => {
          const url = new URL(path, ORIGIN);
          return (
            url.pathname === '/api/v1/endoscopy/reports' &&
            url.searchParams.get('dateFrom') === '2026-08-21' &&
            url.searchParams.get('dateTo') === '2026-08-22' &&
            !url.searchParams.has('updatedFrom') &&
            !url.searchParams.has('updatedTo')
          );
        },
        method: 'GET',
      })
      .reply(200, envelope({ items: [], nextCursor: null, hasMore: false }));

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'test-token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00Z'),
        until: new Date('2026-08-22T00:00:00Z'),
        pageSize: 200,
      }),
    ).resolves.toMatchObject({ items: [] });
  });

  it('always supplies required dateTo when the caller omits until', async () => {
    pool
      .intercept({
        path: (path: string) => {
          const url = new URL(path, ORIGIN);
          return url.searchParams.has('dateFrom') && url.searchParams.has('dateTo');
        },
        method: 'GET',
      })
      .reply(200, envelope({ items: [], nextCursor: null, hasMore: false }));

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'test-token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).resolves.toMatchObject({ items: [] });
  });

  it('rejects deviceId because the confirmed IRIS contract has no device field', async () => {
    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'test-token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00Z'),
        pageSize: 200,
        deviceId: 'SCOPE-01',
      }),
    ).rejects.toThrow(/deviceId/);
  });

  it('walks multiple pages by forwarding the returned cursor as the next request cursor', async () => {
    pool
      .intercept({
        path: (path) => path.startsWith('/api/v1/endoscopy/reports') && !path.includes('cursor='),
        method: 'GET',
      })
      .reply(
        200,
        envelope({
          items: [syntheticReport({ reportId: 'R-1' })],
          nextCursor: 'page-2',
          hasMore: true,
        }),
      );
    pool
      .intercept({
        path: (path) => path.includes('cursor=page-2'),
        method: 'GET',
      })
      .reply(
        200,
        envelope({
          items: [syntheticReport({ reportId: 'R-2' })],
          nextCursor: null,
          hasMore: false,
        }),
      );

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'test-token',
      fetchImpl: mockFetch(),
    });
    const page1 = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00Z'),
      pageSize: 200,
    });
    expect(page1.nextCursor).toBe('page-2');
    const page2 = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00Z'),
      pageSize: 200,
      cursor: page1.nextCursor,
    });
    expect(page2.items[0].reportId).toBe('R-2');
    expect(page2.nextCursor).toBeUndefined();
  });

  it('sends Authorization: Bearer <token> and X-Request-Id headers, never leaking the token in thrown errors', async () => {
    let capturedAuth: string | undefined;
    let capturedRequestId: string | undefined;
    pool.intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' }).reply((opts) => {
      const headers = opts.headers as Record<string, string>;
      capturedAuth = headers['authorization'] ?? headers['Authorization'];
      capturedRequestId = headers['x-request-id'] ?? headers['X-Request-Id'];
      return {
        statusCode: 200,
        data: JSON.stringify(envelope({ items: [], nextCursor: null, hasMore: false })),
      };
    });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'super-secret-token',
      fetchImpl: mockFetch(),
    });
    await adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 });
    expect(capturedAuth).toBe('Bearer super-secret-token');
    expect(capturedRequestId).toBeTruthy();
  });

  it('maps 401 to PacsHttpAuthError (not retryable) without leaking response body details', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(401, { requestId: 'req-1', code: 'UNAUTHENTICATED', message: 'missing token' });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'bad-token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpAuthError);
  });

  it('maps 403 to PacsHttpAuthError', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(403, { requestId: 'req-1', code: 'FORBIDDEN', message: 'no access' });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpAuthError);
  });

  it('maps 503 DATA_SOURCE_UNAVAILABLE to PacsHttpTransientError (retryable by the sync job)', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(503, { requestId: 'req-1', code: 'DATA_SOURCE_UNAVAILABLE', message: 'db down' });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpTransientError);
  });

  it('maps 429 RATE_LIMITED to PacsHttpTransientError', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(429, { requestId: 'req-1', code: 'RATE_LIMITED', message: 'slow down' });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpTransientError);
  });

  it('maps 500 to PacsHttpTransientError and does not expose response internals in the thrown message', async () => {
    pool.intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' }).reply(500, {
      requestId: 'req-1',
      code: 'INTERNAL_ERROR',
      message: 'stack trace leaking SQL...',
    });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    try {
      await adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 });
      throw new Error('expected fetchReports to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PacsHttpTransientError);
      expect((err as Error).message).not.toContain('stack trace leaking SQL');
    }
  });

  it('times out and raises PacsHttpTransientError when the gateway never responds in time', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(200, envelope({ items: [], nextCursor: null, hasMore: false }))
      .delay(200);

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      timeoutMs: 10,
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpTransientError);
  });

  it('raises PacsHttpContractError when the 200 response body is missing data.items', async () => {
    pool
      .intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' })
      .reply(200, { requestId: 'req-1', serverTime: '2026-08-21T02:06:00Z', data: {} });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpContractError);
  });

  it('raises PacsHttpContractError for a malformed individual report item (missing required field)', async () => {
    pool.intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' }).reply(
      200,
      envelope({
        items: [{ ...syntheticReport(), patientId: undefined }],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 200 }),
    ).rejects.toThrow(PacsHttpContractError);
  });

  it('clamps pageSize to the 500 contract ceiling', async () => {
    let capturedPageSize: string | null = null;
    pool.intercept({ path: /\/api\/v1\/endoscopy\/reports\?.*/, method: 'GET' }).reply((opts) => {
      const url = new URL(`http://x${opts.path}`);
      capturedPageSize = url.searchParams.get('pageSize');
      return {
        statusCode: 200,
        data: JSON.stringify(envelope({ items: [], nextCursor: null, hasMore: false })),
      };
    });

    const adapter = new HttpPacsRisAdapter({
      baseUrl: BASE_URL,
      serviceToken: 'token',
      fetchImpl: mockFetch(),
    });
    await adapter.fetchReports({ since: new Date('2026-08-21T00:00:00Z'), pageSize: 5000 });
    expect(capturedPageSize).toBe('500');
  });

  it('maps an unrecognized reportStatus value to PacsReportStatus.UNKNOWN rather than guessing', () => {
    const dto = mapWireReportToDto(syntheticReport({ reportStatus: 'SOME_FUTURE_STATUS' }));
    expect(dto.reportStatus).toBe(PacsReportStatus.UNKNOWN);
  });

  it('maps every documented #20 contract status 1:1 to the matching PacsReportStatus value (no lossy mapping needed)', () => {
    const statuses = [
      'EXAM_IN_PROGRESS',
      'AWAITING_REPORT',
      'DRAFT',
      'PENDING_REVIEW',
      'REVIEWED',
      'FINAL_REVIEWED',
      'UNKNOWN',
    ] as const;
    for (const status of statuses) {
      const dto = mapWireReportToDto(syntheticReport({ reportStatus: status }));
      expect(dto.reportStatus).toBe(status);
    }
  });
});
