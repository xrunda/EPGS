import { parseRulesCsv } from './csv-parser';

describe('parseRulesCsv', () => {
  it('parses a well-formed CSV with all columns', () => {
    const csv =
      'keyword,level,matchField,matchMode,category,notes\n肿瘤,RED,REPORT_TEXT,CONTAINS,tumor,test note\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));

    expect(result.fatalError).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      line: 2,
      keyword: '肿瘤',
      level: 'RED',
      matchField: 'REPORT_TEXT',
      matchMode: 'CONTAINS',
      category: 'tumor',
      notes: 'test note',
    });
  });

  it('parses a CSV with only required columns, leaving optional fields undefined', () => {
    const csv = 'keyword,level,matchField\n肿瘤,RED,REPORT_TEXT\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));

    expect(result.fatalError).toBeUndefined();
    expect(result.rows[0].matchMode).toBeUndefined();
    expect(result.rows[0].category).toBeUndefined();
  });

  it('is case-insensitive and order-independent on header names', () => {
    const csv = 'MatchField,Level,Keyword\nREPORT_TEXT,RED,肿瘤\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));

    expect(result.fatalError).toBeUndefined();
    expect(result.rows[0].keyword).toBe('肿瘤');
  });

  it('reports a fatal error for an empty file', () => {
    const result = parseRulesCsv(Buffer.from('', 'utf8'));
    expect(result.fatalError).toMatch(/empty/i);
    expect(result.rows).toHaveLength(0);
  });

  it('reports a fatal error for a header-only file (no data rows)', () => {
    const result = parseRulesCsv(Buffer.from('keyword,level,matchField\n', 'utf8'));
    expect(result.fatalError).toMatch(/no data rows/i);
  });

  it('reports a fatal error when a required column is missing', () => {
    const csv = 'keyword,level\n肿瘤,RED\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));
    expect(result.fatalError).toMatch(/matchField/);
  });

  it('reports a fatal error for invalid UTF-8 bytes (encoding error)', () => {
    // 0xFF 0xFE is not valid UTF-8 continuation - guaranteed decode failure.
    const invalidUtf8 = Buffer.from([0x6b, 0x65, 0x79, 0xff, 0xfe, 0x00, 0x01]);
    const result = parseRulesCsv(invalidUtf8);
    expect(result.fatalError).toMatch(/UTF-8/i);
  });

  it('strips a UTF-8 BOM if present', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const csv = Buffer.concat([
      bom,
      Buffer.from('keyword,level,matchField\n肿瘤,RED,REPORT_TEXT\n', 'utf8'),
    ]);
    const result = parseRulesCsv(csv);

    expect(result.fatalError).toBeUndefined();
    expect(result.rows[0].keyword).toBe('肿瘤');
  });

  it('reports a fatal error for malformed CSV (unterminated quote)', () => {
    const csv = 'keyword,level,matchField\n"肿瘤,RED,REPORT_TEXT\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));
    expect(result.fatalError).toBeDefined();
  });

  it('assigns 1-based-from-header line numbers matching a text editor view', () => {
    const csv = 'keyword,level,matchField\n癌,RED,REPORT_TEXT\n肿瘤,RED,REPORT_TEXT\n';
    const result = parseRulesCsv(Buffer.from(csv, 'utf8'));
    expect(result.rows[0].line).toBe(2);
    expect(result.rows[1].line).toBe(3);
  });
});
