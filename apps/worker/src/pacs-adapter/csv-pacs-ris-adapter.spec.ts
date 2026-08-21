import { CsvPacsRisAdapter, parseCsvReports } from './csv-pacs-ris-adapter';
import { mapWireReportToDto } from './http-pacs-ris-adapter';

const HEADER = [
  'sourceRecordId',
  'patientRegistrationNo',
  'patientName',
  'department',
  'bedNo',
  'patientTypeCode',
  'patientTypeName',
  'examItem',
  'examDate',
  'examTime',
  'reportContent',
  'diagnosis',
].join(',');

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('CsvPacsRisAdapter', () => {
  it('parses UTF-8 BOM, quoted commas, quoted newlines, Chinese text and empty cells', () => {
    const records = parseCsvReports(
      `\uFEFF${csv(
        'ES-001,REG-001,测试患者甲,内镜中心,,I,,电子胃镜,2026-08-21,09:30:00,"胃体,见隆起\n观察随访",',
      )}`,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceRecordId: 'ES-001',
      patientRegistrationNo: 'REG-001',
      patientName: '测试患者甲',
      bedNo: null,
      patientTypeName: null,
      reportContent: '胃体,见隆起\n观察随访',
      diagnosis: null,
    });
  });

  it('maps the same wire record identically in CSV and HTTP modes', () => {
    const [fromCsv] = parseCsvReports(
      csv(
        'ES-002,REG-002,测试患者乙,消化内科,12,I,住院,电子胃镜,2026-08-21,10:05:30,合成报告,合成诊断',
      ),
    );
    const fromHttp = mapWireReportToDto({
      sourceRecordId: 'ES-002',
      patientRegistrationNo: 'REG-002',
      patientName: '测试患者乙',
      department: '消化内科',
      bedNo: '12',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜',
      examDate: '2026-08-21',
      examTime: '10:05:30',
      reportContent: '合成报告',
      diagnosis: '合成诊断',
    });

    expect(fromCsv).toEqual(fromHttp);
  });

  it('rejects missing columns without logging row contents', () => {
    expect(() => parseCsvReports('sourceRecordId,examDate\nES-003,2026-08-21')).toThrow(
      /missing required column/i,
    );
  });

  it('rejects duplicate sourceRecordId values', () => {
    const duplicate = csv(
      'ES-004,,,,,,,,2026-08-21,09:00:00,,',
      'ES-004,,,,,,,,2026-08-21,10:00:00,,',
    );
    expect(() => parseCsvReports(duplicate)).toThrow(/duplicate sourceRecordId.*ES-004/i);
  });

  it('rejects an invalid row without exposing report or diagnosis text', () => {
    const secretText = '不应出现的报告正文';
    const invalid = csv(`ES-005,,,,,,,,2026-99-99,09:00:00,${secretText},秘密诊断`);
    try {
      parseCsvReports(invalid);
      throw new Error('expected parsing to fail');
    } catch (error) {
      expect((error as Error).message).toMatch(/row 2/i);
      expect((error as Error).message).not.toContain(secretText);
      expect((error as Error).message).not.toContain('秘密诊断');
    }
  });

  it('rejects a date-shaped value that is not a real calendar date', () => {
    const invalid = csv('ES-006,,,,,,,,2026-02-31,09:00:00,合成报告,合成诊断');
    expect(() => parseCsvReports(invalid)).toThrow(/row 2/i);
  });

  it('filters by date window and department and paginates in stable order', async () => {
    const adapter = new CsvPacsRisAdapter({
      csvText: csv(
        'ES-012,,,内镜中心,,,,,2026-08-22,08:00:00,,',
        'ES-011,,,内镜中心,,,,,2026-08-21,10:00:00,,',
        'ES-010,,,消化内科,,,,,2026-08-21,09:00:00,,',
        'ES-009,,,内镜中心,,,,,2026-08-21,09:00:00,,',
      ),
    });

    const page1 = await adapter.fetchReports({
      since: new Date('2026-08-20T16:00:00Z'),
      until: new Date('2026-08-21T16:00:00Z'),
      department: '内镜中心',
      pageSize: 1,
    });
    expect(page1.items.map((item) => item.sourceRecordId)).toEqual(['ES-009']);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await adapter.fetchReports({
      since: new Date('2026-08-20T16:00:00Z'),
      until: new Date('2026-08-21T16:00:00Z'),
      department: '内镜中心',
      pageSize: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((item) => item.sourceRecordId)).toEqual(['ES-011']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('returns an empty page for an empty data file', async () => {
    const adapter = new CsvPacsRisAdapter({ csvText: `${HEADER}\n` });
    await expect(
      adapter.fetchReports({ since: new Date('2026-08-01T00:00:00Z'), pageSize: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: undefined });
  });

  it('fails clearly when the configured CSV file does not exist', () => {
    expect(() => new CsvPacsRisAdapter({ filePath: '/definitely/missing/moke-data.csv' })).toThrow(
      /cannot read mock CSV/i,
    );
  });
});
