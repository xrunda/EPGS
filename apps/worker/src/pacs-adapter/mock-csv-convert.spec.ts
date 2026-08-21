import { parseCsvReports } from './csv-pacs-ris-adapter';
import {
  convertMockCsv,
  decodeGb18030,
  derivePatientType,
  normalizeMockExamDate,
  normalizeMockExamTime,
} from './mock-csv-convert';

const SOURCE_HEADER = '检查号,登记号,姓名,科室,床号,类型,检查项目,检查日期,检查时间,报告内容,诊断';

describe('convertMockCsv', () => {
  it('maps a Chinese-header GB18030-era export onto the English wire columns', () => {
    const source = [
      SOURCE_HEADER,
      'ES-001,REG-001,测试患者甲,内镜中心,,I,电子胃镜,2026-8-2 0:00,8:48:08,"胃体,见隆起\n观察随访",',
      'ES-002,REG-002,测试患者乙,消化内科,12,O,肠镜,2026-08-03,10:05:30,合成报告,合成诊断',
    ].join('\n');

    const { csv, dataRowCount } = convertMockCsv(source);
    expect(dataRowCount).toBe(2);
    expect(csv.split('\n')[0]).toBe(
      'sourceRecordId,patientRegistrationNo,patientName,department,bedNo,' +
        'patientTypeCode,patientTypeName,examItem,examDate,examTime,reportContent,diagnosis',
    );

    // The converted output must satisfy the exact adapter contract (this is
    // the same parseCsvReports the CLI and the CSV adapter run).
    const records = parseCsvReports(csv);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      sourceRecordId: 'ES-001',
      patientRegistrationNo: 'REG-001',
      patientName: '测试患者甲',
      department: '内镜中心',
      bedNo: null,
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜',
      examDate: '2026-08-02',
      examTimeText: '08:48:08',
      reportContent: '胃体,见隆起\n观察随访',
      diagnosis: null,
    });
    expect(records[1]).toMatchObject({
      sourceRecordId: 'ES-002',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examDate: '2026-08-03',
      examTimeText: '10:05:30',
      bedNo: '12',
      diagnosis: '合成诊断',
    });
  });

  it('keeps empty optional cells empty (adapter maps them to null)', () => {
    const source = [SOURCE_HEADER, 'ES-003,,,,,,电子胃镜,2026-8-5,09:00:00,,诊断三'].join('\n');
    const { csv, dataRowCount } = convertMockCsv(source);
    expect(dataRowCount).toBe(1);
    const [record] = parseCsvReports(csv);
    expect(record).toMatchObject({
      sourceRecordId: 'ES-003',
      patientRegistrationNo: null,
      patientName: null,
      department: null,
      patientTypeCode: null,
      patientTypeName: null,
      examItem: '电子胃镜',
      examDate: '2026-08-05',
      examTimeText: '09:00:00',
      diagnosis: '诊断三',
    });
  });

  it('rejects a header that no longer matches the hospital export', () => {
    const source = [
      '检查号X,登记号,姓名,科室,床号,类型,检查项目,检查日期,检查时间,报告内容,诊断',
      'ES-001,REG-001,测试患者甲,内镜中心,1,I,电子胃镜,2026-8-2,08:00:00,报告,诊断',
    ].join('\n');
    expect(() => convertMockCsv(source)).toThrow(/header mismatch at column 1/i);
  });

  it('handles a header-only export (zero data rows)', () => {
    const { csv, dataRowCount } = convertMockCsv(`${SOURCE_HEADER}\n`);
    expect(dataRowCount).toBe(0);
    expect(parseCsvReports(csv)).toEqual([]);
  });
});

describe('normalizeMockExamDate', () => {
  it('pads the month/day and drops the embedded Excel time artifact', () => {
    expect(normalizeMockExamDate('2026-8-2 0:00')).toBe('2026-08-02');
    expect(normalizeMockExamDate('2026-12-31 0:00')).toBe('2026-12-31');
    expect(normalizeMockExamDate('2026-8-2')).toBe('2026-08-02');
  });

  it('passes already-conforming or malformed values through unchanged', () => {
    expect(normalizeMockExamDate('2026-08-02')).toBe('2026-08-02');
    expect(normalizeMockExamDate('not a date')).toBe('not a date');
  });
});

describe('normalizeMockExamTime', () => {
  it('pads a non-padded hour', () => {
    expect(normalizeMockExamTime('8:48:08')).toBe('08:48:08');
    expect(normalizeMockExamTime('10:02:23')).toBe('10:02:23');
    expect(normalizeMockExamTime('09:30:00.123')).toBe('09:30:00.123');
  });

  it('passes malformed values through unchanged', () => {
    expect(normalizeMockExamTime('')).toBe('');
    expect(normalizeMockExamTime('25:99:99')).toBe('25:99:99');
  });
});

describe('derivePatientType', () => {
  it('maps I/O to code + dictionary label', () => {
    expect(derivePatientType('I')).toEqual({ code: 'I', name: '住院' });
    expect(derivePatientType('O')).toEqual({ code: 'O', name: '门诊' });
  });

  it('keeps an unknown Chinese label as the display name with an empty code', () => {
    expect(derivePatientType('住院')).toEqual({ code: '', name: '住院' });
  });

  it('keeps an unknown non-Chinese code and clears the name', () => {
    expect(derivePatientType('X')).toEqual({ code: 'X', name: '' });
  });

  it('treats an empty cell as empty', () => {
    expect(derivePatientType('')).toEqual({ code: '', name: '' });
  });
});

describe('decodeGb18030', () => {
  it('decodes GBK bytes for 检查号 to the header cell', () => {
    // 检 = BC EC, 查 = B2 E9, 号 = BA C5 in GBK.
    expect(decodeGb18030(Buffer.from([0xbc, 0xec, 0xb2, 0xe9, 0xba, 0xc5]))).toBe('检查号');
  });
});
