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

  it('selects the converged read-only field set (no status/sex/age columns)', () => {
    const { sql } = buildFetchReportsQuery({ since: SINCE, pageSize: 10 });

    expect(sql).toContain('AS SOURCE_RECORD_ID');
    expect(sql).toContain('AS PATIENT_TYPE_CODE');
    expect(sql).toContain('AS PATIENT_TYPE_NAME');
    expect(sql).toContain('AS REPORT_CONTENT');
    expect(sql).toContain('AS DIAGNOSIS');
    expect(sql).not.toContain('REPORT_STATUS');
    expect(sql).not.toContain('SEX_CODE');
    expect(sql).not.toContain('AGE');
    expect(sql).not.toContain('INPATIENT_NO');
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
        SOURCE_RECORD_ID: 'ACC-1',
        PATIENT_NAME: '测试患者甲',
        DEPARTMENT_NAME: '消化内科',
        BED_NO: '12',
        PATIENT_TYPE_CODE: 'I',
        PATIENT_TYPE_NAME: '住院',
        EXAM_ITEM: '胃镜检查',
        EXAM_TIME: '2026-08-01T01:00:00.000Z',
        REPORT_ID: 'RPT-1',
        REPORT_CONTENT: '所见描述',
        DIAGNOSIS: '诊断意见',
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
      sourceRecordId: 'ACC-1',
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '12',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '胃镜检查',
      reportId: 'RPT-1',
      reportContent: '所见描述',
      diagnosis: '诊断意见',
    });
    expect(result.items[0].examTime).toBeInstanceOf(Date);
    expect(result.items[0].sourceUpdatedAt).toBeInstanceOf(Date);
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

  it('passes through nullable snapshot fields and unknown patient type code verbatim', async () => {
    const rows = [
      {
        SOURCE_RECORD_ID: 'ACC-2',
        PATIENT_NAME: '测试患者乙',
        DEPARTMENT_NAME: null,
        BED_NO: null,
        PATIENT_TYPE_CODE: 'Z',
        PATIENT_TYPE_NAME: null,
        EXAM_ITEM: '肠镜检查',
        EXAM_TIME: '2026-08-01T01:00:00.000Z',
        REPORT_ID: 'RPT-2',
        REPORT_CONTENT: null,
        DIAGNOSIS: null,
        SOURCE_UPDATED_AT: '2026-08-01T02:00:05.000Z',
      },
    ];
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue(rows) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, pageSize: 10 });

    expect(result.items[0]).toMatchObject({
      department: null,
      bedNo: null,
      patientTypeCode: 'Z',
      patientTypeName: null,
      reportContent: null,
      diagnosis: null,
    });
  });
});
