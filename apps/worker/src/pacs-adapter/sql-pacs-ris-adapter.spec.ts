import { PacsReportStatus } from '@epgs/shared-types';
import {
  buildFetchReportsQuery,
  MAX_PAGE_SIZE,
  ParameterizedQueryExecutor,
  SqlPacsRisAdapter,
} from './sql-pacs-ris-adapter';

const SINCE = new Date('2026-08-01T00:00:00.000Z');

describe('buildFetchReportsQuery', () => {
  it('throws when since is missing', () => {
    // @ts-expect-error intentionally omitting required field
    expect(() => buildFetchReportsQuery({ pageSize: 10 })).toThrow(/since/);
  });

  it('always includes a lower and upper time bound using bound params, not literals', () => {
    const { sql, boundParams } = buildFetchReportsQuery({ since: SINCE, pageSize: 10 });

    expect(sql).toContain('r.SOURCE_UPDATED_AT >= @since');
    expect(sql).toContain('r.SOURCE_UPDATED_AT < @until');
    expect(boundParams.since).toBe(SINCE);
    expect(boundParams.until).toBeInstanceOf(Date);
  });

  it('uses TOP (@pageSize) and caps pageSize at MAX_PAGE_SIZE', () => {
    const { sql, boundParams } = buildFetchReportsQuery({ since: SINCE, pageSize: 999999 });

    expect(sql).toContain('TOP (@pageSize)');
    expect(boundParams.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('floors pageSize at 1 for non-positive input', () => {
    const { boundParams } = buildFetchReportsQuery({ since: SINCE, pageSize: -5 });
    expect(boundParams.pageSize).toBe(1);
  });

  it('binds department/deviceId as parameters rather than concatenating into SQL', () => {
    const { sql, boundParams } = buildFetchReportsQuery({
      since: SINCE,
      pageSize: 10,
      department: "消化内科'; DROP TABLE PATIENTINFO; --",
      deviceId: 'SCOPE-01',
    });

    expect(sql).toContain('loc.DEPARTMENT_NAME = @department');
    expect(sql).toContain('s.DEVICE_ID = @deviceId');
    expect(sql).not.toContain('DROP TABLE');
    expect(boundParams.department).toBe("消化内科'; DROP TABLE PATIENTINFO; --");
    expect(boundParams.deviceId).toBe('SCOPE-01');
  });

  it('produces static SQL text regardless of param values (no string interpolation of values)', () => {
    const a = buildFetchReportsQuery({ since: SINCE, pageSize: 10, department: 'A' });
    const b = buildFetchReportsQuery({ since: SINCE, pageSize: 10, department: 'B' });
    expect(a.sql).toBe(b.sql);
  });

  it('joins STUDYINFO/PATIENTINFO/REPORTINFO/REPORTCONTENT/LOC on the documented keys', () => {
    const { sql } = buildFetchReportsQuery({ since: SINCE, pageSize: 10 });

    expect(sql).toContain('FROM STUDYINFO s');
    expect(sql).toContain('INNER JOIN PATIENTINFO p ON s.PAT_ID = p.PAT_ID');
    expect(sql).toContain('INNER JOIN REPORTINFO r ON r.ST_ACCNUM = s.ST_ACCNUM');
    expect(sql).toContain(
      'LEFT JOIN REPORTCONTENT rc ON rc.ST_ACCNUM = s.ST_ACCNUM AND rc.REPORT_ID = r.REPORT_ID',
    );
  });

  it('orders deterministically for stable keyset pagination', () => {
    const { sql } = buildFetchReportsQuery({ since: SINCE, pageSize: 10 });
    expect(sql).toContain('ORDER BY r.SOURCE_UPDATED_AT ASC, r.REPORT_ID ASC');
  });

  it('rejects an invalid cursor', () => {
    expect(() => buildFetchReportsQuery({ since: SINCE, pageSize: 10, cursor: 'garbage' })).toThrow(
      /cursor/,
    );
  });

  it('applies a keyset predicate when a valid cursor is provided', () => {
    const cursor = Buffer.from('2026-08-01T01:00:00.000Z|RPT-000001', 'utf8').toString('base64');
    const { sql, boundParams } = buildFetchReportsQuery({ since: SINCE, pageSize: 10, cursor });

    expect(sql).toContain('r.SOURCE_UPDATED_AT > @cursorTs');
    expect(sql).toContain('r.REPORT_ID > @cursorId');
    expect(boundParams.cursorId).toBe('RPT-000001');
    expect((boundParams.cursorTs as Date).toISOString()).toBe('2026-08-01T01:00:00.000Z');
  });
});

describe('SqlPacsRisAdapter', () => {
  it('throws a clear error when no query executor is configured', async () => {
    const adapter = new SqlPacsRisAdapter();
    await expect(adapter.fetchReports({ since: SINCE, pageSize: 10 })).rejects.toThrow(
      /ParameterizedQueryExecutor/,
    );
  });

  it('rejects a non-positive pageSize before touching the executor', async () => {
    const executor: ParameterizedQueryExecutor = { query: jest.fn() };
    const adapter = new SqlPacsRisAdapter(executor);

    await expect(adapter.fetchReports({ since: SINCE, pageSize: 0 })).rejects.toThrow(/pageSize/);
    expect(executor.query).not.toHaveBeenCalled();
  });

  it('maps raw rows to PacsReportDto and derives nextCursor only when a full page is returned', async () => {
    const rows = [
      {
        PAT_ID: 'PAT-0001',
        INPATIENT_NO: 'IP-100001',
        PATIENT_NAME: '测试患者甲',
        SEX_CODE: 'M',
        AGE: 54,
        DEPARTMENT_NAME: '消化内科',
        BED_NO: '12',
        ST_ACCNUM: 'ACC-1',
        EXAM_ITEM: '胃镜检查',
        EXAM_TIME: '2026-08-01T01:00:00.000Z',
        REPORT_ID: 'RPT-1',
        REPORT_STATUS: 'FINAL',
        REPORT_SAVED_AT: '2026-08-01T01:10:00.000Z',
        REPORT_SUBMITTED_AT: '2026-08-01T01:15:00.000Z',
        REPORT_REVIEWED_AT: '2026-08-01T02:00:00.000Z',
        RPT_DESCRIBE: '所见描述',
        RPT_DIAGNOSE: '诊断意见',
        SOURCE_UPDATED_AT: '2026-08-01T02:00:05.000Z',
      },
    ];
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue(rows) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, pageSize: 1 });

    expect(executor.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (executor.query as jest.Mock).mock.calls[0];
    expect(typeof sql).toBe('string');
    expect(params).toMatchObject({ since: SINCE, pageSize: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      patientId: 'PAT-0001',
      inpatientNo: 'IP-100001',
      studyAccessionNo: 'ACC-1',
      reportStatus: PacsReportStatus.FINAL_REVIEWED,
      describeText: '所见描述',
      diagnoseText: '诊断意见',
    });
    expect(result.items[0].examTime).toBeInstanceOf(Date);
    // Page came back full (1 row for pageSize 1), so there may be more.
    expect(result.nextCursor).toBeDefined();
  });

  it('returns no nextCursor when fewer rows than pageSize come back (last page)', async () => {
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue([]) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, pageSize: 10 });

    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('maps an unrecognized REPORT_STATUS to UNKNOWN, not FINAL_REVIEWED', async () => {
    const rows = [
      {
        PAT_ID: 'PAT-0002',
        INPATIENT_NO: null,
        PATIENT_NAME: '测试患者乙',
        SEX_CODE: 'X',
        AGE: null,
        DEPARTMENT_NAME: null,
        BED_NO: null,
        ST_ACCNUM: 'ACC-2',
        EXAM_ITEM: '肠镜检查',
        EXAM_TIME: '2026-08-01T01:00:00.000Z',
        REPORT_ID: 'RPT-2',
        REPORT_STATUS: 'SOME_UNMAPPED_CODE',
        REPORT_SAVED_AT: null,
        REPORT_SUBMITTED_AT: null,
        REPORT_REVIEWED_AT: null,
        RPT_DESCRIBE: null,
        RPT_DIAGNOSE: null,
        SOURCE_UPDATED_AT: '2026-08-01T02:00:05.000Z',
      },
    ];
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue(rows) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, pageSize: 10 });

    expect(result.items[0].reportStatus).toBe(PacsReportStatus.UNKNOWN);
    expect(result.items[0].sex).toBe('UNKNOWN');
    expect(result.items[0].inpatientNo).toBeNull();
  });
});
