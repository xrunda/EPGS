import { buildNotificationVariables, formatKeywordHits, renderTemplate } from './render';

describe('renderTemplate', () => {
  const variables = {
    reportDate: '2026-08-23',
    hospitalName: '菏泽市中医医院',
    totalCount: '7',
  };

  it('replaces every {{key}} token with its value', () => {
    expect(renderTemplate('{{reportDate}} {{hospitalName}} 共{{totalCount}}例', variables)).toBe(
      '2026-08-23 菏泽市中医医院 共7例',
    );
  });

  it('trims whitespace inside the token', () => {
    expect(renderTemplate('{{ totalCount }}', variables)).toBe('7');
  });

  it('leaves unknown tokens verbatim instead of silently dropping them', () => {
    expect(renderTemplate('{{unknownVar}} 和 {{totalCount}}', variables)).toBe(
      '{{unknownVar}} 和 7',
    );
  });

  it('leaves a template with no tokens unchanged', () => {
    const text = '每日重点报告汇总';
    expect(renderTemplate(text, variables)).toBe(text);
  });

  it('replaces repeated tokens', () => {
    expect(renderTemplate('{{totalCount}}/{{totalCount}}', variables)).toBe('7/7');
  });
});

describe('buildNotificationVariables', () => {
  it('maps a summary to the fixed dictionary keys including keyword hits', () => {
    const summary = {
      total: 7,
      red: 2,
      yellow: 1,
      green: 3,
      unclassified: 1,
      keywordHits: [
        { keyword: '恶性肿瘤', level: 'RED' as const, count: 2 },
        { keyword: '穿孔', level: 'RED' as const, count: 1 },
        { keyword: '肿物', level: 'YELLOW' as const, count: 1 },
      ],
    };
    expect(
      buildNotificationVariables(summary, { reportDate: '2026-08-23', hospitalName: '菏泽市中医医院' }),
    ).toEqual({
      reportDate: '2026-08-23',
      hospitalName: '菏泽市中医医院',
      redCount: '2',
      yellowCount: '1',
      greenCount: '3',
      unclassifiedCount: '1',
      totalCount: '7',
      redKeywords: '恶性肿瘤 ×2、穿孔 ×1',
      yellowKeywords: '肿物 ×1',
    });
  });
});

describe('formatKeywordHits', () => {
  const red = (keyword: string, count: number) => ({ keyword, level: 'RED' as const, count });

  it('formats hits of the requested level as 词 ×次数 joined by 、', () => {
    expect(formatKeywordHits([red('穿孔', 1), red('恶性肿瘤', 3)], 'RED', 5)).toBe(
      '恶性肿瘤 ×3、穿孔 ×1',
    );
  });

  it('sorts by count desc, ties by keyword asc for stability', () => {
    expect(formatKeywordHits([red('NEN', 1), red('Ca', 1)], 'RED', 5)).toBe('Ca ×1、NEN ×1');
  });

  it('caps at topN and appends 其他 N 词共 M 次', () => {
    const hits = [red('a', 5), red('b', 4), red('c', 3), red('d', 2)];
    expect(formatKeywordHits(hits, 'RED', 2)).toBe('a ×5、b ×4、其他 2 词共 5 次');
  });

  it('returns — when the level has no hits', () => {
    expect(formatKeywordHits([red('恶性肿瘤', 1)], 'YELLOW', 5)).toBe('—');
  });

  it('ignores hits of other levels', () => {
    expect(formatKeywordHits([{ keyword: '肿物', level: 'YELLOW' as const, count: 2 }], 'RED', 5)).toBe(
      '—',
    );
  });
});
