import { isCronDueAt, isValidCronExpression } from './cron';

describe('isValidCronExpression', () => {
  it.each(['0 9 * * *', '0 8 * * *', '0 9 * * 1', '*/30 * * * *'])(
    'accepts %s',
    (expression) => {
      expect(isValidCronExpression(expression)).toBe(true);
    },
  );

  it.each(['', '9 * *', '0 25 * * *', 'not a cron'])('rejects %s', (expression) => {
    expect(isValidCronExpression(expression)).toBe(false);
  });
});

describe('isCronDueAt (Asia/Shanghai)', () => {
  it('is due when the cron fires within the minute containing `at` (minute alignment)', () => {
    // 09:00:30 Shanghai still belongs to the 09:00 minute -> "0 9 * * *" is due.
    expect(isCronDueAt('0 9 * * *', new Date('2026-08-23T01:00:30Z'), 'Asia/Shanghai')).toBe(true);
  });

  it('is not due in the minute after the fire time', () => {
    expect(isCronDueAt('0 9 * * *', new Date('2026-08-23T01:01:00Z'), 'Asia/Shanghai')).toBe(false);
  });

  it('every-30-minutes fires at :00 and :30 Shanghai, not in between', () => {
    expect(isCronDueAt('*/30 * * * *', new Date('2026-08-23T01:29:59Z'), 'Asia/Shanghai')).toBe(false);
    expect(isCronDueAt('*/30 * * * *', new Date('2026-08-23T01:30:00Z'), 'Asia/Shanghai')).toBe(true);
    expect(isCronDueAt('*/30 * * * *', new Date('2026-08-23T01:30:59Z'), 'Asia/Shanghai')).toBe(true);
    expect(isCronDueAt('*/30 * * * *', new Date('2026-08-23T01:31:00Z'), 'Asia/Shanghai')).toBe(false);
  });

  it('evaluates the expression in the named timezone, not the process TZ', () => {
    // 01:00Z == 09:00 Shanghai. Due in Shanghai...
    const at = new Date('2026-08-23T01:00:00Z');
    expect(isCronDueAt('0 9 * * *', at, 'Asia/Shanghai')).toBe(true);
    // ...but 01:00 UTC is NOT 09:00 UTC, so the same instant is not due in UTC.
    expect(isCronDueAt('0 9 * * *', at, 'UTC')).toBe(false);
  });

  it('treats a Shanghai midnight cron as due at the cross-day boundary', () => {
    // 2026-08-23T00:00:00+08 == 2026-08-22T16:00:00Z.
    const atMidnightShanghai = new Date('2026-08-22T16:00:00Z');
    expect(isCronDueAt('0 0 * * *', atMidnightShanghai, 'Asia/Shanghai')).toBe(true);
    // The same instant is 16:00 UTC the previous day - not midnight in UTC.
    expect(isCronDueAt('0 0 * * *', atMidnightShanghai, 'UTC')).toBe(false);
  });
});
