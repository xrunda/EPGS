import { buildNotificationVariables, renderTemplate } from './render';

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
  it('maps a summary to the 7 fixed dictionary keys', () => {
    const summary = { total: 7, red: 2, yellow: 1, green: 3, unclassified: 1 };
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
    });
  });
});
