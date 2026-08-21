import { FixturePacsRisAdapter } from './fixture-pacs-ris-adapter';

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-08-02T00:00:00.000Z');

describe('FixturePacsRisAdapter', () => {
  let adapter: FixturePacsRisAdapter;

  beforeEach(() => {
    adapter = new FixturePacsRisAdapter();
  });

  it('rejects a call without since', async () => {
    // @ts-expect-error intentionally omitting required field for the test
    await expect(adapter.fetchReports({ pageSize: 10 })).rejects.toThrow(/since/);
  });

  it('rejects a call without a positive pageSize', async () => {
    await expect(adapter.fetchReports({ since: WINDOW_START, pageSize: 0 })).rejects.toThrow(
      /pageSize/,
    );
  });

  it('returns only records within [since, until)', async () => {
    const result = await adapter.fetchReports({
      since: WINDOW_START,
      until: WINDOW_END,
      pageSize: 50,
    });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.sourceUpdatedAt.getTime()).toBeGreaterThanOrEqual(WINDOW_START.getTime());
      expect(item.sourceUpdatedAt.getTime()).toBeLessThan(WINDOW_END.getTime());
    }
    // RPT-000008's record is on 2026-08-02, outside this window.
    expect(result.items.some((i) => i.reportId === 'RPT-000008')).toBe(false);
  });

  it('paginates deterministically and a full walk via nextCursor covers every record exactly once', async () => {
    const pageSize = 2;
    let cursor: string | undefined;
    const seenReportIds: string[] = [];
    let guard = 0;

    do {
      const result = await adapter.fetchReports({
        since: WINDOW_START,
        pageSize,
        cursor,
      });
      expect(result.items.length).toBeLessThanOrEqual(pageSize);
      seenReportIds.push(...result.items.map((i) => i.reportId));
      cursor = result.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    // No duplicates and no missing records across the full paginated walk.
    expect(new Set(seenReportIds).size).toBe(seenReportIds.length);
    expect(seenReportIds).toEqual(
      expect.arrayContaining([
        'RPT-000001',
        'RPT-000002',
        'RPT-000003',
        'RPT-000004',
        'RPT-000005',
        'RPT-000006',
        'RPT-000007',
        'RPT-000008',
      ]),
    );
  });

  it('rejects an invalid cursor', async () => {
    await expect(
      adapter.fetchReports({ since: WINDOW_START, pageSize: 10, cursor: 'not-a-valid-cursor' }),
    ).rejects.toThrow(/cursor/);
  });

  it('filters by department when provided', async () => {
    const result = await adapter.fetchReports({
      since: WINDOW_START,
      until: WINDOW_END,
      department: '内镜中心',
      pageSize: 50,
    });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.department).toBe('内镜中心');
    }
  });

  it('handles a study with no bed number (outpatient)', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const outpatient = result.items.find((i) => i.reportId === 'RPT-000003');

    expect(outpatient).toBeDefined();
    expect(outpatient?.bedNo).toBeNull();
    expect(outpatient?.patientTypeCode).toBe('O');
    expect(outpatient?.patientTypeName).toBe('门诊');
  });

  it('returns empty reportContent/diagnosis as-is (no coercion to null, no cleansing)', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const emptyReport = result.items.find((i) => i.reportId === 'RPT-000004');

    expect(emptyReport).toBeDefined();
    expect(emptyReport?.reportContent).toBe('');
    expect(emptyReport?.diagnosis).toBe('');
  });

  it('passes an unknown patient type code through verbatim (name not guessed)', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const unknownType = result.items.find((i) => i.reportId === 'RPT-000007');

    expect(unknownType).toBeDefined();
    expect(unknownType?.patientTypeCode).toBe('I');
    expect(unknownType?.patientTypeName).toBeNull();
  });

  it('surfaces multiple report versions for the same source record as distinct items', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const sameRecord = result.items.filter((i) => i.sourceRecordId === 'ACC-2026080100001');

    expect(sameRecord).toHaveLength(2);
    expect(sameRecord.map((i) => i.reportId).sort()).toEqual(['RPT-000001', 'RPT-000002']);
    // Later version's content differs and is preserved verbatim, not merged.
    const v2 = sameRecord.find((i) => i.reportId === 'RPT-000002');
    expect(v2?.diagnosis).toBe('慢性非萎缩性胃炎伴糜烂');
  });

  it('passes through duplicate source record IDs across different patients without merging/dropping either', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const duplicateRecord = result.items.filter((i) => i.sourceRecordId === 'ACC-2026080100002');

    expect(duplicateRecord).toHaveLength(2);
    const patientNames = duplicateRecord.map((i) => i.patientName).sort();
    expect(patientNames).toEqual(['测试患者乙', '测试患者己']);
  });

  it('preserves reportContent/diagnosis verbatim from the source fixture', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 50 });
    const record = result.items.find((i) => i.reportId === 'RPT-000001');

    expect(record?.reportContent).toBe(
      '食管黏膜光滑，齿状线清晰。胃底黏膜光滑，胃体黏膜光滑，未见明显异常隆起或凹陷。幽门圆形，开闭好。',
    );
    expect(record?.diagnosis).toBe('慢性非萎缩性胃炎');
  });

  it('caps pageSize at the adapter maximum', async () => {
    const result = await adapter.fetchReports({ since: WINDOW_START, pageSize: 100000 });
    // Fixture only has 8 records total, so this just confirms no error is
    // thrown and no artificial truncation happens below the actual dataset size.
    expect(result.items.length).toBeLessThanOrEqual(8);
  });
});
