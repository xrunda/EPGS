import {
  buildFetchReportsQuery,
  MAX_PAGE_SIZE,
  ParameterizedQueryExecutor,
  SqlPacsRisAdapter,
} from './sql-pacs-ris-adapter';

const SINCE = new Date('2026-08-01T00:00:00.000Z');
const UNTIL = new Date('2026-08-04T00:00:00.000Z');

describe('buildFetchReportsQuery', () => {
  it('queries the confirmed IRIS tables and fields', () => {
    const { sql } = buildFetchReportsQuery({ since: SINCE, until: UNTIL, pageSize: 10 });

    expect(sql).toContain('FROM Ens_RISReportResult a');
    expect(sql).toContain('LEFT JOIN PA_Adm pa ON pa.PAADM_RowID = a.RISR_VisitNumber');
    expect(sql).toContain('LEFT JOIN PA_PatMas pp ON a.RISR_PatientID = pp.PAPMI_RowId1');
    expect(sql).toContain('a.RISR_ExamID AS SOURCE_RECORD_ID');
    expect(sql).toContain('pp.PAPMI_No AS PATIENT_REGISTRATION_NO');
    expect(sql).toContain('pa.PAADM_DepCode_DR->CTLOC_Desc AS DEPARTMENT');
    expect(sql).toContain('pa.PAADM_CurrentBed_DR->BED_Code AS BED_NO');
    expect(sql).toContain('a.RISR_ExamDesc AS REPORT_CONTENT');
    expect(sql).toContain('a.RISR_DiagDesc AS DIAGNOSIS');
  });

  it('uses positional parameters for the bounded Shanghai date-time window and ES system code', () => {
    const { sql, boundParams } = buildFetchReportsQuery({
      since: SINCE,
      until: UNTIL,
      pageSize: 10,
    });

    expect(sql).toContain('SELECT TOP ?');
    expect(sql).toContain("COALESCE(a.RISR_ReportTime, '00:00:00') >= ?");
    expect(sql).toContain("COALESCE(a.RISR_ReportTime, '00:00:00') < ?");
    expect(sql).toContain('a.RISR_SysCode = ?');
    expect(boundParams).toEqual([
      10,
      '2026-08-01',
      '2026-08-01',
      '08:00:00',
      '2026-08-04',
      '2026-08-04',
      '08:00:00',
      'ES',
    ]);
  });

  it('caps pageSize at MAX_PAGE_SIZE', () => {
    const { boundParams } = buildFetchReportsQuery({
      since: SINCE,
      until: UNTIL,
      pageSize: 999999,
    });
    expect(boundParams[0]).toBe(MAX_PAGE_SIZE);
  });

  it('binds the department filter and never interpolates its value', () => {
    const department = "消化内科'; DELETE FROM PA_Adm; --";
    const { sql, boundParams } = buildFetchReportsQuery({
      since: SINCE,
      until: UNTIL,
      pageSize: 10,
      department,
    });

    expect(sql).toContain('pa.PAADM_DepCode_DR->CTLOC_Desc = ?');
    expect(sql).not.toContain('DELETE FROM');
    expect(boundParams).toContain(department);
  });

  it('orders deterministically by report date, time, and examination id', () => {
    const { sql } = buildFetchReportsQuery({ since: SINCE, until: UNTIL, pageSize: 10 });
    expect(sql).toContain(
      "ORDER BY a.RISR_ReportDate ASC, COALESCE(a.RISR_ReportTime, '00:00:00') ASC, a.RISR_ExamID ASC",
    );
  });

  it('uses a null-safe report time in cursor pagination', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ date: '2026-08-02', time: '00:00:00', id: 'ES20260802013' }),
      'utf8',
    ).toString('base64');
    const { sql, boundParams } = buildFetchReportsQuery({
      since: SINCE,
      until: UNTIL,
      pageSize: 10,
      cursor,
    });

    expect(sql).toContain("COALESCE(a.RISR_ReportTime, '00:00:00') > ?");
    expect(sql).toContain("COALESCE(a.RISR_ReportTime, '00:00:00') = ?");
    expect(boundParams).toEqual(
      expect.arrayContaining(['2026-08-02', '00:00:00', 'ES20260802013']),
    );
  });

  it('rejects unsupported device filters instead of silently ignoring them', () => {
    expect(() =>
      buildFetchReportsQuery({ since: SINCE, until: UNTIL, pageSize: 10, deviceId: 'SCOPE-01' }),
    ).toThrow(/deviceId/);
  });
});

describe('SqlPacsRisAdapter', () => {
  it('maps confirmed IRIS columns to the canonical read-only fields', async () => {
    const rows = [
      {
        SOURCE_RECORD_ID: 'ES20260802013',
        PATIENT_REGISTRATION_NO: '0000533611',
        PATIENT_NAME: '测试患者甲',
        DEPARTMENT: '消化内科',
        BED_NO: '40',
        PATIENT_TYPE_CODE: 'I',
        EXAM_ITEM: '电子结肠镜检查',
        EXAM_DATE: '2026-08-02',
        EXAM_TIME: '10:31:18',
        REPORT_CONTENT: '合成检查所见',
        DIAGNOSIS: '合成诊断',
      },
    ];
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue(rows) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, until: UNTIL, pageSize: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceRecordId: 'ES20260802013',
      patientRegistrationNo: '0000533611',
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '40',
      patientTypeCode: 'I',
      examItem: '电子结肠镜检查',
      examDate: '2026-08-02',
      examTimeText: '10:31:18',
      reportContent: '合成检查所见',
      diagnosis: '合成诊断',
    });
  });

  it('preserves nullable department, bed, report content, and diagnosis', async () => {
    const rows = [
      {
        SOURCE_RECORD_ID: 'ES20260802014',
        PATIENT_REGISTRATION_NO: null,
        PATIENT_NAME: null,
        DEPARTMENT: null,
        BED_NO: null,
        PATIENT_TYPE_CODE: 'O',
        EXAM_ITEM: null,
        EXAM_DATE: '2026-08-02',
        EXAM_TIME: null,
        REPORT_CONTENT: null,
        DIAGNOSIS: null,
      },
    ];
    const executor: ParameterizedQueryExecutor = { query: jest.fn().mockResolvedValue(rows) };
    const adapter = new SqlPacsRisAdapter(executor);

    const result = await adapter.fetchReports({ since: SINCE, until: UNTIL, pageSize: 10 });
    expect(result.items[0]).toMatchObject({
      department: null,
      bedNo: null,
      patientRegistrationNo: null,
      patientName: null,
      examItem: null,
      examTimeText: null,
      reportContent: null,
      diagnosis: null,
    });
  });

  it('rejects rows without RISR_ExamID', async () => {
    const executor: ParameterizedQueryExecutor = {
      query: jest.fn().mockResolvedValue([
        {
          SOURCE_RECORD_ID: '',
          PATIENT_REGISTRATION_NO: '0000533612',
          PATIENT_NAME: '测试患者乙',
          DEPARTMENT: null,
          BED_NO: null,
          PATIENT_TYPE_CODE: 'O',
          EXAM_ITEM: '电子胃镜检查',
          EXAM_DATE: '2026-08-02',
          EXAM_TIME: '09:00:00',
          REPORT_CONTENT: null,
          DIAGNOSIS: null,
        },
      ]),
    };
    const adapter = new SqlPacsRisAdapter(executor);

    await expect(
      adapter.fetchReports({ since: SINCE, until: UNTIL, pageSize: 10 }),
    ).rejects.toThrow(/RISR_ExamID/);
  });
});
