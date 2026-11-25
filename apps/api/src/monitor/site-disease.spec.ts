import { MatchField, MonitorLevel } from '@prisma/client';
import { SiteDiseaseMatch, deriveSiteDisease } from './site-disease';

/**
 * Issue #159: the derivation is a pure text function, so every case here is a
 * synthetic literal. The repo is public - never paste a real export value in.
 */
function match(
  keyword: string,
  level: MonitorLevel = 'RED',
  matchedField: MatchField = 'FINDINGS',
  matchStart: number | null = null,
  matchEnd: number | null = null,
): SiteDiseaseMatch {
  return { keyword, level, matchedField, matchStart, matchEnd };
}

describe('deriveSiteDisease (issue #159)', () => {
  it('takes the organ from the diagnosis and refines it from the body (胃癌 -> 胃体+癌)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃体小弯侧见菜花样肿物，表面溃破。',
        diagnosis: '胃癌（进展期）。',
        matches: [match('癌', 'RED', 'IMPRESSION')],
      }),
    ).toBe('胃体+癌');
  });

  it('keeps a specific sub-site and a long disease name (胃窦+腺癌)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌。',
        diagnosis: '胃窦腺癌。',
        matches: [match('腺癌', 'RED', 'IMPRESSION')],
      }),
    ).toBe('胃窦+腺癌');
  });

  it('pairs a colon site with 息肉 (结肠+息肉)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '结肠可见多发息肉样隆起。',
        diagnosis: '1.结肠多发息肉+CFP术\r2.内痔\r',
        matches: [match('息肉', 'RED', 'FINDINGS', 4, 6)],
      }),
    ).toBe('结肠+息肉');
  });

  it('uses the site nearest the anchor, not the first site in the body (食管中段+恶性肿瘤)', () => {
    const report = '食管中段见环周浸润性改变，黏膜表面粗糙不平。';
    expect(
      deriveSiteDisease({
        reportContent: report,
        diagnosis: '食管恶性肿瘤。',
        matches: [match('环周浸润', 'RED', 'FINDINGS', 5, 9)],
      }),
    ).toBe('食管中段+恶性肿瘤');
  });

  it('falls back to the anchor field for a site the diagnosis does not name (胃体+间质瘤)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃体见黏膜下肿物，镜下考虑间质瘤。',
        diagnosis: '间质瘤。',
        matches: [match('间质瘤', 'RED', 'FINDINGS', 13, 16)],
      }),
    ).toBe('胃体+间质瘤');
  });

  it('labels a missing site instead of inventing one (部位未明+腺癌)', () => {
    expect(
      deriveSiteDisease({
        reportContent: null,
        diagnosis: '腺癌。',
        matches: [match('腺癌', 'RED', 'IMPRESSION')],
      }),
    ).toBe('部位未明+腺癌');
  });

  it('falls back to the anchor keyword when the diagnosis names no disease (胃窦+占位)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃窦见占位性病变。',
        diagnosis: '性质待病理。',
        matches: [match('占位', 'RED', 'FINDINGS', 3, 5)],
      }),
    ).toBe('胃窦+占位');
  });

  it('returns an empty cell when the record has no effective match', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃窦见一处隆起性病变。',
        diagnosis: '胃腺癌。',
        matches: [],
      }),
    ).toBe('');
  });

  it('prefers the longest disease term (高级别上皮内瘤变 beats 癌)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃窦见一处粗糙凹陷。',
        diagnosis: '胃窦高级别上皮内瘤变。',
        matches: [match('高级别上皮内瘤变', 'YELLOW', 'IMPRESSION')],
      }),
    ).toBe('胃窦+高级别上皮内瘤变');
  });

  it('matches Latin names case-insensitively (Barrett)', () => {
    expect(
      deriveSiteDisease({
        reportContent: '食管下段见橘红色黏膜。',
        diagnosis: 'Barrett 食管。',
        matches: [match('barrett', 'YELLOW', 'IMPRESSION')],
      }),
    ).toBe('食管下段+Barrett');
  });

  it('ignores an unrelated disease in the same diagnosis (胃+癌, not 结肠+息肉)', () => {
    const diagnosis = '结肠息肉；胃癌';
    expect(
      deriveSiteDisease({
        reportContent: null,
        diagnosis,
        matches: [
          match('癌', 'RED', 'IMPRESSION', diagnosis.indexOf('癌'), diagnosis.indexOf('癌') + 1),
        ],
      }),
    ).toBe('胃+癌');
  });

  it('picks the highest-level hit as the anchor when a record has several', () => {
    expect(
      deriveSiteDisease({
        reportContent: '胃窦见息肉样隆起；贲门见浸润性病变。',
        diagnosis: '贲门浸润癌。',
        matches: [match('息肉', 'YELLOW', 'FINDINGS', 4, 6), match('浸润癌', 'RED', 'IMPRESSION')],
      }),
    ).toBe('贲门+浸润癌');
  });

  it('handles a multi-line body without crossing the line break', () => {
    expect(
      deriveSiteDisease({
        reportContent: '镜下所见：\r\n胃窦见一处隆起。\r\n诊断：胃窦腺癌。',
        diagnosis: '胃窦腺癌。',
        matches: [match('腺癌', 'RED', 'IMPRESSION')],
      }),
    ).toBe('胃窦+腺癌');
  });
});
