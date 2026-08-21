import { formatShanghai } from './time-format';

describe('formatShanghai', () => {
  it('formats a UTC instant as Asia/Shanghai wall-clock time (UTC+8, no DST)', () => {
    // 2026-08-21T00:00:00Z is 2026-08-21 08:00:00 in Asia/Shanghai.
    const formatted = formatShanghai(new Date('2026-08-21T00:00:00.000Z'));
    expect(formatted).toBe('2026-08-21 08:00:00 (Asia/Shanghai)');
  });

  it('rolls over to the next day when the UTC instant is late in the UTC day (cross-day boundary)', () => {
    // 2026-08-21T16:30:00Z -> 2026-08-22 00:30:00 in Asia/Shanghai.
    const formatted = formatShanghai(new Date('2026-08-21T16:30:00.000Z'));
    expect(formatted).toBe('2026-08-22 00:30:00 (Asia/Shanghai)');
  });

  it('produces the same UTC+8 offset year-round (China has no DST, unlike many other zones)', () => {
    const winter = formatShanghai(new Date('2026-01-15T00:00:00.000Z'));
    const summer = formatShanghai(new Date('2026-07-15T00:00:00.000Z'));
    expect(winter).toBe('2026-01-15 08:00:00 (Asia/Shanghai)');
    expect(summer).toBe('2026-07-15 08:00:00 (Asia/Shanghai)');
  });
});
