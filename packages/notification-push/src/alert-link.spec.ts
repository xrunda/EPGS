import {
  ALERT_LINK_TOKEN_RE,
  AlertLinkIssuer,
  AlertLinkIssuerDeps,
  AlertLinkStore,
  buildAlertLinkUrl,
  generateAlertLinkToken,
  hashAlertLinkToken,
} from './alert-link';
import { NotificationSummaryProvider } from './summary';
import { PushSummary } from './types';

const NOW = new Date('2026-09-05T01:00:00Z'); // 09:00 Shanghai

function makeSummary(overrides: Partial<PushSummary> = {}): PushSummary {
  return {
    total: 6,
    red: 2,
    yellow: 1,
    green: 3,
    unclassified: 0,
    keywordHits: [
      { keyword: '疑似穿孔', level: 'RED', count: 1 },
      { keyword: '活动性出血', level: 'RED', count: 2 },
      { keyword: '息肉待复核', level: 'YELLOW', count: 1 },
    ],
    ...overrides,
  };
}

function makeStore(
  idsByLevel: Partial<Record<'RED' | 'YELLOW' | 'GREEN', string[]>> = {
    RED: ['r1', 'r2'],
    YELLOW: ['y1'],
    GREEN: ['g1', 'g2', 'g3'],
  },
): { listRecordIdsByLevel: jest.Mock; createAlertLink: jest.Mock } {
  let seq = 0;
  return {
    listRecordIdsByLevel: jest.fn(async () => idsByLevel),
    createAlertLink: jest.fn(async () => ({ id: `link-${++seq}` })),
  };
}

function build(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<AlertLinkIssuerDeps> = {},
): AlertLinkIssuer {
  let tokenSeq = 0;
  const summary = { get: jest.fn(async () => makeSummary()) };
  return new AlertLinkIssuer({
    store: store as unknown as AlertLinkStore,
    summary: summary as unknown as NotificationSummaryProvider,
    baseUrl: 'http://10.0.0.5:5173/',
    ttlHours: 24,
    hospitalNameProvider: () => '菏泽市中医医院',
    tokenGenerator: () => `token-${String(++tokenSeq).padStart(32, '0')}`,
    nowProvider: () => NOW,
    ...overrides,
  });
}

describe('alert-link token helpers', () => {
  it('generates a 43-char base64url token that matches the guard regex and is unique', () => {
    const a = generateAlertLinkToken();
    const b = generateAlertLinkToken();
    expect(a).toHaveLength(43);
    expect(a).toMatch(ALERT_LINK_TOKEN_RE);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to sha256 hex and never returns the token itself', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const hash = hashAlertLinkToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashAlertLinkToken(token));
    expect(hash).not.toContain(token);
  });

  it('builds the H5 URL under /alert with the token as ?t=, tolerating trailing slashes', () => {
    expect(buildAlertLinkUrl('http://10.0.0.5:5173/', 'tok_-1')).toBe(
      'http://10.0.0.5:5173/alert?t=tok_-1',
    );
    expect(buildAlertLinkUrl('https://epgs.example', 'x')).toBe('https://epgs.example/alert?t=x');
  });
});

describe('AlertLinkIssuer.issue', () => {
  it('is disabled (no cards, no rows, no queries) when baseUrl is null', async () => {
    const store = makeStore();
    const issuer = build(store, { baseUrl: null });

    expect(issuer.enabled).toBe(false);
    const cards = await issuer.issue({ windowDate: '2026-09-05', pushLogId: 'log-1' });

    expect(cards).toEqual([]);
    expect(store.listRecordIdsByLevel).not.toHaveBeenCalled();
    expect(store.createAlertLink).not.toHaveBeenCalled();
  });

  it('freezes one snapshot + hashed token per non-empty level, in RED/YELLOW/GREEN order', async () => {
    const store = makeStore();
    const issuer = build(store);

    const cards = await issuer.issue({
      windowDate: '2026-09-05',
      pushLogId: 'log-1',
      scope: ['内镜中心'],
    });

    expect(store.listRecordIdsByLevel).toHaveBeenCalledWith({
      windowDate: '2026-09-05',
      scope: ['内镜中心'],
    });
    expect(cards.map((card) => [card.level, card.count])).toEqual([
      ['RED', 2],
      ['YELLOW', 1],
      ['GREEN', 3],
    ]);

    expect(store.createAlertLink).toHaveBeenCalledTimes(3);
    const red = store.createAlertLink.mock.calls[0][0];
    expect(red).toMatchObject({
      level: 'RED',
      windowDate: '2026-09-05',
      pushLogId: 'log-1',
      recordIds: ['r1', 'r2'],
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });
    // Only the hash is persisted; the raw token appears only in the URL.
    expect(red.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(red)).not.toContain('token-');
    expect(cards[0].url).toBe(
      `http://10.0.0.5:5173/alert?t=${encodeURIComponent('token-00000000000000000000000000000001')}`,
    );
    // Cover image on the same origin (trailing slash on baseUrl normalized away).
    expect(cards.map((card) => card.coverUrl)).toEqual(
      Array(3).fill('http://10.0.0.5:5173/hospital-logo.jpg'),
    );
    expect(hashAlertLinkToken('token-00000000000000000000000000000001')).toBe(red.tokenHash);
  });

  it('skips levels with zero records (no card, no row) - user decision', async () => {
    const store = makeStore({ RED: [], YELLOW: ['y1'] });
    const issuer = build(store);

    const cards = await issuer.issue({ windowDate: '2026-09-05', pushLogId: null });

    expect(cards.map((card) => card.level)).toEqual(['YELLOW']);
    expect(store.createAlertLink).toHaveBeenCalledTimes(1);
    expect(store.createAlertLink.mock.calls[0][0]).toMatchObject({
      level: 'YELLOW',
      pushLogId: null,
    });
  });

  it('returns no cards when every level is empty', async () => {
    const store = makeStore({});
    const cards = await build(store).issue({ windowDate: '2026-09-05', pushLogId: 'log-1' });
    expect(cards).toEqual([]);
    expect(store.createAlertLink).not.toHaveBeenCalled();
  });

  it('writes card copy with the level label, count, date, hospital, TOP-3 keywords and the TTL', async () => {
    const store = makeStore();
    const cards = await build(store).issue({ windowDate: '2026-09-05', pushLogId: 'log-1' });

    expect(cards[0].title).toBe('红色关注 2 例 · 2026-09-05');
    expect(cards[0].description).toBe(
      '菏泽市中医医院｜命中：活动性出血 ×2、疑似穿孔 ×1｜点击查看患者列表（脱敏），链接 24 小时内有效',
    );
    // GREEN has no keyword hits: the 命中 segment is omitted rather than rendering "—".
    expect(cards[2].description).toBe(
      '菏泽市中医医院｜点击查看患者列表（脱敏），链接 24 小时内有效',
    );
  });

  it('honors a custom ttlHours for expiresAt and the copy', async () => {
    const store = makeStore({ RED: ['r1'] });
    const cards = await build(store, { ttlHours: 48 }).issue({
      windowDate: '2026-09-05',
      pushLogId: 'log-1',
    });

    expect(store.createAlertLink.mock.calls[0][0].expiresAt).toEqual(
      new Date(NOW.getTime() + 48 * 60 * 60 * 1000),
    );
    expect(cards[0].description).toContain('链接 48 小时内有效');
  });

  it('uses the injected `now` over nowProvider when given', async () => {
    const store = makeStore({ RED: ['r1'] });
    const anchor = new Date('2026-09-06T02:00:00Z');
    await build(store).issue({ windowDate: '2026-09-06', pushLogId: 'log-2', now: anchor });

    expect(store.createAlertLink.mock.calls[0][0]).toMatchObject({
      createdAt: anchor,
      expiresAt: new Date(anchor.getTime() + 24 * 60 * 60 * 1000),
    });
  });

  it('propagates a store failure (the executor degrades to no cards)', async () => {
    const store = makeStore();
    store.createAlertLink.mockRejectedValueOnce(new Error('db down'));
    await expect(
      build(store).issue({ windowDate: '2026-09-05', pushLogId: 'log-1' }),
    ).rejects.toThrow('db down');
  });
});
