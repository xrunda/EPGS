import { MonitorLevel } from '@prisma/client';
import {
  CSV_LEVEL_LABELS,
  CsvExamRow,
  buildExamsCsv,
  contentDispositionFor,
  csvFileName,
  orderExportLevels,
} from './monitor-csv';

const HEADER =
  '关注等级,患者姓名,性别,科室,床号,患者类型,开单医生,检查项目,检查日期,检查时间,命中关键词,手机号,报告内容,诊断,部位+病名';

const BOM = '﻿';

function textOf(rows: CsvExamRow[]): string {
  return buildExamsCsv(rows).toString('utf8');
}

/** The data lines only, splitting on the CRLF the writer is required to use. */
function dataLines(rows: CsvExamRow[]): string[] {
  const body = textOf(rows).slice(BOM.length);
  // The final CRLF produces a trailing empty element - drop it, it is asserted
  // separately.
  return body.split('\r\n').slice(0, -1);
}

/** Synthetic literals only (…000000). The repo is public - never paste a value
 *  out of a real export into this file. */
const baseRow: CsvExamRow = {
  examTime: new Date('2026-08-20T08:15:30.000Z'), // 2026-08-20 16:15:30 +08
  currentLevel: 'RED' as MonitorLevel,
  patientName: '张三丰',
  patientSex: '男',
  patientPhone: '13800000000',
  department: '消化内科',
  bedNo: '12-1',
  patientTypeCode: 'I',
  patientTypeName: '住院',
  examItem: '电子胃镜检查',
  // Issue #151: the file now carries the report body and the diagnosis in full.
  reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌。',
  diagnosis: '胃腺癌（早期）。',
  orderingDoctor: '王医生',
  matches: [{ keyword: '腺癌' }, { keyword: '高级别上皮内瘤变' }],
};

describe('buildExamsCsv (issue #139)', () => {
  it('writes a UTF-8 BOM so Excel reads the Chinese headers as UTF-8', () => {
    // Byte-level, not string-level: `Buffer.toString` would happily strip a
    // BOM that was never written, so assert the three actual bytes.
    expect([...buildExamsCsv([]).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(textOf([]).startsWith(BOM)).toBe(true);
  });

  it('writes the exact header row in the documented column order', () => {
    expect(textOf([])).toBe(`${BOM}${HEADER}\r\n`);
  });

  it('terminates every line with CRLF (RFC 4180) and ends with one', () => {
    const body = textOf([baseRow]).slice(BOM.length);
    expect(body.endsWith('\r\n')).toBe(true);
    expect(body.split('\r\n')).toHaveLength(3); // header + 1 row + trailing ''
    expect(body).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it('renders one row with the on-screen column values', () => {
    expect(dataLines([baseRow])).toEqual([
      HEADER,
      '红色关注,张三丰,男,消化内科,12-1,住院（I）,王医生,电子胃镜检查,2026-08-20,16:15:30,腺癌、高级别上皮内瘤变,13800000000,胃窦见一处隆起性病变，病理提示黏膜内腺癌。,胃腺癌（早期）。,胃窦+腺癌',
    ]);
  });

  it('formats the exam instant as Asia/Shanghai wall time, not UTC', () => {
    // 08:15:30Z is 16:15:30 in +08. A naive toISOString() would put the row on
    // the wrong day for anything after 16:00Z, which is most of a shift.
    const [header, row] = dataLines([baseRow]);
    expect(header).toContain('检查日期');
    expect(row).toContain('2026-08-20,16:15:30');
  });

  describe('level labels', () => {
    it.each([
      ['RED', '红色关注'],
      ['YELLOW', '黄色关注'],
      ['GREEN', '绿色关注'],
      ['UNCLASSIFIED', '未分级'],
    ])('renders %s as %s', (level, label) => {
      const [, row] = dataLines([{ ...baseRow, currentLevel: level as MonitorLevel }]);
      expect(row.startsWith(`${label},`)).toBe(true);
      expect(CSV_LEVEL_LABELS[level as MonitorLevel]).toBe(label);
    });
  });

  it('exports the patient phone in the clear and never a masked form', () => {
    // The owner's 2026-10-16 decision. This endpoint is gated on patientDetail
    // precisely so this cell can be raw - if a future change masks it here, the
    // file silently stops being what the ward asked for.
    const file = textOf([baseRow]);
    expect(file).toContain('13800000000');
    expect(file).not.toContain('138****0000');
    expect(file).not.toContain('*');
  });

  describe('empty cells', () => {
    it('writes NULL as an empty cell, not the screen dash', () => {
      // The five nullable #137-era fields are the point: with no backfill, a
      // pre-#137 record legitimately has none of them.
      const [, row] = dataLines([
        {
          ...baseRow,
          patientSex: null,
          patientPhone: null,
          orderingDoctor: null,
          bedNo: null,
          department: null,
          reportContent: null,
          diagnosis: null,
        },
      ]);
      // 关注等级,患者姓名,性别(空),科室(空),床号(空),患者类型,开单医生(空),...
      // 手机号(空),报告内容(空),诊断(空) - three trailing empty cells.
      expect(row).toBe(
        '红色关注,张三丰,,,,' +
          '住院（I）' +
          ',,电子胃镜检查,2026-08-20,16:15:30,腺癌、高级别上皮内瘤变,,,,部位未明+腺癌',
      );
      expect(row).not.toContain('—');
    });

    it('survives a row whose examTime is null instead of throwing', () => {
      const [, row] = dataLines([{ ...baseRow, examTime: null }]);
      // 检查项目 keeps its value; the date and time cells after it go empty.
      expect(row).toContain(',电子胃镜检查,,,腺癌');
    });

    it('keeps a keyword cell empty when nothing matched', () => {
      const [, row] = dataLines([{ ...baseRow, matches: [] }]);
      expect(row).toContain(',16:15:30,,13800000000');
    });
  });

  describe('patient type', () => {
    it.each([
      ['住院', 'I', '住院（I）'],
      [null, 'I', 'I'],
      ['住院', null, '住院'],
      [null, null, ''],
    ])('renders name=%p code=%p as %p', (name, code, expected) => {
      const [, row] = dataLines([{ ...baseRow, patientTypeName: name, patientTypeCode: code }]);
      expect(row.split(',')[5]).toBe(expected);
    });
  });

  describe('keyword joining', () => {
    it('joins with 、 so no keyword can interact with the delimiter', () => {
      const [, row] = dataLines([
        { ...baseRow, matches: [{ keyword: '腺癌' }, { keyword: '低级别' }, { keyword: '息肉' }] },
      ]);
      expect(row).toContain('腺癌、低级别、息肉');
      // One cell, not three columns. 15 columns since #159 (the two report
      // columns and the derived site+disease at the tail); the report body has
      // no ASCII comma here, so a naive split still counts cells correctly.
      expect(row.split(',')).toHaveLength(15);
    });
  });

  describe('report body and diagnosis (issue #151)', () => {
    it('carries both fields in full, in the two trailing columns', () => {
      // The whole point of #151: the file must be self-contained for 随访 - the
      // doctor reads what was found and what was treated without reopening the
      // drawer per patient.
      const [, row] = dataLines([baseRow]);
      expect(
        row.endsWith(
          ',13800000000,胃窦见一处隆起性病变，病理提示黏膜内腺癌。,胃腺癌（早期）。,胃窦+腺癌',
        ),
      ).toBe(true);
    });

    it('writes NULL report/diagnosis as empty cells, like every other column', () => {
      const [, row] = dataLines([{ ...baseRow, reportContent: null, diagnosis: null }]);
      // A pre-#137-style legacy record may have neither; the cell stays empty
      // rather than growing a dash.
      expect(row.endsWith(',13800000000,,,部位未明+腺癌')).toBe(true);
    });

    it('quotes a multi-line report body per RFC 4180, so the row stays one line', () => {
      // Real endoscopy reports carry line breaks between 镜下所见 and 诊断意见;
      // the cell must be quoted or Excel would tear the row apart.
      const lines = textOf([
        { ...baseRow, reportContent: '镜下所见：\n黏膜充血水肿。\n诊断：慢性胃炎。' },
      ])
        .slice(BOM.length)
        .split('\r\n');
      // Header + ONE data row (the newlines live inside a quoted cell) + trailing ''.
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('"镜下所见：\n黏膜充血水肿。\n诊断：慢性胃炎。"');
    });

    it('guards the report body against formula injection like any other cell', () => {
      const [, row] = dataLines([{ ...baseRow, reportContent: '=HYPERLINK("http://x")' }]);
      // The guard runs before quoting: the apostrophe is the Excel text marker.
      expect(row.endsWith(`,"'=HYPERLINK(""http://x"")",胃腺癌（早期）。,胃+腺癌`)).toBe(true);
    });
  });

  describe('RFC 4180 quoting', () => {
    it.each([
      ['含,逗号', '"含,逗号"'],
      ['含"引号', '"含""引号"'],
      ['含\n换行', '"含\n换行"'],
      ['含\r回车', '"含\r回车"'],
      ['普通值', '普通值'],
    ])('quotes %p as %p', (value, expected) => {
      const [, row] = dataLines([{ ...baseRow, examItem: value }]);
      // examItem is the 8th column.
      expect(row).toContain(`,${expected},2026-08-20`);
    });

    it('quotes a phone that carries a separator, so the column count holds', () => {
      const rows = dataLines([{ ...baseRow, patientPhone: '138-0000,0000' }]);
      // No longer the last column (#151 appended the two report columns after
      // it), so assert on the quoted cell rather than the end of the line.
      expect(rows[1]).toContain('"138-0000,0000"');
    });
  });

  describe('formula-injection guard', () => {
    it.each([
      ['=1+1', "'=1+1"],
      ["=cmd|'/c calc'!A1", "'=cmd|'/c calc'!A1"],
      ['+8613800000000', "'+8613800000000"],
      ['-2+3', "'-2+3"],
      ['@SUM(A1)', "'@SUM(A1)"],
    ])('prefixes %p with the Excel text marker', (value, expected) => {
      const [, row] = dataLines([{ ...baseRow, patientName: value }]);
      expect(row.split(',')[1]).toBe(expected);
    });

    it('leaves ordinary values alone, including a plain phone number', () => {
      // The guard must not fire on digits: a stray apostrophe in every phone
      // cell would be worse than the risk it removes.
      const [, row] = dataLines([baseRow]);
      expect(row).toContain(',13800000000');
      expect(row).not.toContain("'");
    });

    it('guards before quoting, so the marker survives a quoted cell', () => {
      const [, row] = dataLines([{ ...baseRow, examItem: '=A1,B2' }]);
      expect(row).toContain(`,"'=A1,B2",`);
    });
  });

  it('produces a header-only file for an empty day rather than nothing', () => {
    // Callers still get a parseable CSV; whether to SAVE it is the modal's
    // decision (it does not, and says so).
    expect(dataLines([])).toEqual([HEADER]);
  });
});

describe('orderExportLevels (issue #145)', () => {
  it('puts the selection in the red-to-unclassified order, whatever came in', () => {
    expect(orderExportLevels(['UNCLASSIFIED', 'GREEN', 'RED'])).toEqual([
      'RED',
      'GREEN',
      'UNCLASSIFIED',
    ]);
    expect(orderExportLevels(['YELLOW'])).toEqual(['YELLOW']);
  });

  it('de-duplicates, so a level ticked twice is one level', () => {
    // The same level cannot be selected twice through the checkbox UI, but the
    // query string is a public surface: `?levels=RED,RED,RED` must not turn into
    // a filename with 红色关注 three times, nor into a `in (RED,RED,RED)` clause.
    expect(orderExportLevels(['RED', 'YELLOW', 'RED'])).toEqual(['RED', 'YELLOW']);
    expect(orderExportLevels(['RED', 'RED', 'RED', 'RED'])).toEqual(['RED']);
  });

  it('is idempotent, so the DTO can normalize what the client already normalized', () => {
    const once = orderExportLevels(['YELLOW', 'RED']);
    expect(orderExportLevels(once)).toEqual(once);
  });

  it('KEEPS an unrecognised value at the end instead of dropping it', () => {
    // Dropping it here would turn `?levels=RED,PURPLE` into a 200 that quietly
    // exports only red - the caller gets a file and never learns half the
    // request was ignored. It must reach @IsEnum and become a 400.
    expect(orderExportLevels(['PURPLE', 'RED'])).toEqual(['RED', 'PURPLE']);
    expect(orderExportLevels(['RED', 'PURPLE', 'PURPLE'])).toEqual(['RED', 'PURPLE']);
  });
});

describe('csvFileName', () => {
  it('names the file in the operator’s language, per day and level', () => {
    expect(csvFileName('2026-08-20', '2026-08-20', ['RED'])).toBe(
      '数据导出-2026-08-20-红色关注.csv',
    );
    expect(csvFileName('2026-08-20', '2026-08-20', ['UNCLASSIFIED'])).toBe(
      '数据导出-2026-08-20-未分级.csv',
    );
  });

  it('joins several levels with `+`, always in the red-to-unclassified order (#145)', () => {
    expect(csvFileName('2026-08-20', '2026-08-20', ['RED', 'YELLOW'])).toBe(
      '数据导出-2026-08-20-红色关注+黄色关注.csv',
    );
    expect(csvFileName('2026-08-20', '2026-08-20', ['UNCLASSIFIED', 'RED', 'GREEN'])).toBe(
      '数据导出-2026-08-20-红色关注+绿色关注+未分级.csv',
    );
  });

  it('is a function of the SELECTION, not of the caller’s order or repetitions', () => {
    // The modal sends whatever the operator ticked; the same choice must not be
    // able to download under two different names (and pile up `…(1).csv`).
    const canonical = csvFileName('2026-08-20', '2026-08-20', ['RED', 'YELLOW']);
    expect(csvFileName('2026-08-20', '2026-08-20', ['YELLOW', 'RED'])).toBe(canonical);
    expect(csvFileName('2026-08-20', '2026-08-20', ['YELLOW', 'RED', 'RED', 'YELLOW'])).toBe(
      canonical,
    );
  });

  it('names a multi-day range with both ends, and a single day exactly as before (#157)', () => {
    expect(csvFileName('2026-08-18', '2026-08-20', ['RED'])).toBe(
      '数据导出-2026-08-18_2026-08-20-红色关注.csv',
    );
    expect(csvFileName('2026-08-18', '2026-08-20', ['YELLOW', 'RED'])).toBe(
      '数据导出-2026-08-18_2026-08-20-红色关注+黄色关注.csv',
    );
    // The degenerate range must not change the pre-#157 name byte-for-byte:
    // re-running "today" overwrites the same file instead of creating `(1)`.
    expect(csvFileName('2026-08-20', '2026-08-20', ['RED'])).toBe(
      '数据导出-2026-08-20-红色关注.csv',
    );
  });
});

describe('contentDispositionFor', () => {
  it('sends an ASCII filename and the RFC 5987 UTF-8 form, in that order', () => {
    expect(contentDispositionFor('2026-08-20', '2026-08-20', ['RED'])).toBe(
      `attachment; filename="monitor-2026-08-20-RED.csv"; ` +
        `filename*=UTF-8''%E6%95%B0%E6%8D%AE%E5%AF%BC%E5%87%BA-2026-08-20-%E7%BA%A2%E8%89%B2%E5%85%B3%E6%B3%A8.csv`,
    );
  });

  it('joins the ASCII leg with `-`, so no download manager reads it as a space', () => {
    expect(contentDispositionFor('2026-08-20', '2026-08-20', ['RED', 'YELLOW'])).toContain(
      'filename="monitor-2026-08-20-RED-YELLOW.csv"',
    );
    // …and the Chinese leg keeps the `+` a human would write.
    expect(contentDispositionFor('2026-08-20', '2026-08-20', ['RED', 'YELLOW'])).toContain(
      `${encodeURIComponent('红色关注+黄色关注')}.csv`,
    );
  });

  it('keeps the plain filename leg free of non-ASCII bytes', () => {
    // A client that ignores filename* must still get a usable name, and an
    // intermediary that assumes Latin-1 must still see a valid header.
    const header = contentDispositionFor('2026-08-20', '2026-08-20', ['YELLOW']);
    const plain = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(plain).toBe('monitor-2026-08-20-YELLOW.csv');
    expect(/^[\x20-\x7e]*$/.test(plain)).toBe(true);
  });

  it('carries a multi-day range into both filename legs (#157)', () => {
    const header = contentDispositionFor('2026-08-18', '2026-08-20', ['RED']);
    expect(header).toContain('filename="monitor-2026-08-18_2026-08-20-RED.csv"');
    const utf8 = /filename\*=UTF-8''([^;]*)$/.exec(header)?.[1] ?? '';
    expect(decodeURIComponent(utf8)).toBe('数据导出-2026-08-18_2026-08-20-红色关注.csv');
  });

  it('reads the same for a two-level selection as csvFileName does', () => {
    // The header and the modal's `anchor.download` name must agree - the twin
    // contract in the module comment. Boundary: '+' in the Chinese leg would be
    // percent-encoded by a naive encoder, so assert on the decoded value.
    const header = contentDispositionFor('2026-08-20', '2026-08-20', ['RED', 'YELLOW']);
    const utf8 = /filename\*=UTF-8''([^;]*)$/.exec(header)?.[1] ?? '';
    expect(decodeURIComponent(utf8)).toBe(
      csvFileName('2026-08-20', '2026-08-20', ['RED', 'YELLOW']),
    );
  });
});
