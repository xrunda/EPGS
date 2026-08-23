import { formatShanghaiDate, resolveShanghaiDayRange } from './summary';

describe('resolveShanghaiDayRange', () => {
  it('resolves a Shanghai day to [00:00+08, next 00:00+08) UTC instants', () => {
    const range = resolveShanghaiDayRange('2026-08-23');
    // 2026-08-23T00:00:00+08:00 == 2026-08-22T16:00:00Z
    expect(range.gte.toISOString()).toBe('2026-08-22T16:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });

  it('is exactly one 24h Shanghai day wide (no DST in Asia/Shanghai)', () => {
    const range = resolveShanghaiDayRange('2026-08-23');
    expect(range.lt.getTime() - range.gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects a non-YYYY-MM-DD format', () => {
    expect(() => resolveShanghaiDayRange('2026/08/23')).toThrow(/Invalid date/);
    expect(() => resolveShanghaiDayRange('20260823')).toThrow(/Invalid date/);
  });

  it('rejects an impossible calendar date instead of silently normalizing it', () => {
    // 2026-02-31 does not exist; V8 would normalize it to 03-03 if unchecked.
    expect(() => resolveShanghaiDayRange('2026-02-31')).toThrow(/Invalid date/);
    expect(() => resolveShanghaiDayRange('2026-13-01')).toThrow(/Invalid date/);
  });
});

describe('formatShanghaiDate', () => {
  it('formats a UTC instant as the Shanghai wall-clock date', () => {
    // 09:00 Shanghai on 08-23 == 01:00Z on 08-23.
    expect(formatShanghaiDate(new Date('2026-08-23T01:00:00Z'))).toBe('2026-08-23');
  });

  it('rolls the date forward for instants in the Shanghai early hours', () => {
    // 00:00 Shanghai on 08-23 == 16:00Z on 08-22.
    expect(formatShanghaiDate(new Date('2026-08-22T16:00:00Z'))).toBe('2026-08-23');
  });

  it('rolls the date forward when Shanghai has already passed into the next day', () => {
    // 00:00 Shanghai on 08-24 == 16:00Z on 08-23.
    expect(formatShanghaiDate(new Date('2026-08-23T16:00:00Z'))).toBe('2026-08-24');
  });
});
