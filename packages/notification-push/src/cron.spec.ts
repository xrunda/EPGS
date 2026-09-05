import {
  earliestNextTriggerAt,
  getNextTriggerAt,
  isCronDueAt,
  isValidCronExpression,
} from './cron';

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

describe('getNextTriggerAt (Asia/Shanghai)', () => {
  it('returns today 18:00 Shanghai when asked at 17:00 the same day', () => {
    // 2026-09-03T09:00:00Z == 17:00 Shanghai; next "0 18 * * *" == 18:00 == 10:00Z.
    const from = new Date('2026-09-03T09:00:00Z');
    expect(getNextTriggerAt('0 18 * * *', from).toISOString()).toBe('2026-09-03T10:00:00.000Z');
  });

  it('rolls to the next day once the fire time has passed', () => {
    // 2026-09-03T10:30:00Z == 18:30 Shanghai; next fire is tomorrow 18:00.
    const from = new Date('2026-09-03T10:30:00Z');
    expect(getNextTriggerAt('0 18 * * *', from).toISOString()).toBe('2026-09-04T10:00:00.000Z');
  });

  it('has strictly-after semantics at the exact fire instant', () => {
    // Asking AT 18:00:00 returns tomorrow, not the current minute.
    const atFire = new Date('2026-09-03T10:00:00Z');
    expect(getNextTriggerAt('0 18 * * *', atFire).toISOString()).toBe('2026-09-04T10:00:00.000Z');
  });

  it('evaluates the expression in Asia/Shanghai, not the process TZ', () => {
    const from = new Date('2026-09-03T09:00:00Z');
    // In UTC, "0 18 * * *" next fires at 18:00Z the same day.
    expect(getNextTriggerAt('0 18 * * *', from, 'UTC').toISOString()).toBe('2026-09-03T18:00:00.000Z');
  });
});

describe('earliestNextTriggerAt', () => {
  it('returns null for an empty rule list (no enabled rules -> "未排程")', () => {
    expect(earliestNextTriggerAt([], new Date('2026-09-03T09:00:00Z'))).toBeNull();
  });

  it('picks the soonest fire across several crons', () => {
    const from = new Date('2026-09-03T09:00:00Z'); // 17:00 Shanghai
    // "0 18 * * *" -> today 18:00 (10:00Z); "0 8 * * *" -> tomorrow 08:00 (2026-09-04T00:00Z).
    const earliest = earliestNextTriggerAt(['0 8 * * *', '0 18 * * *'], from);
    expect(earliest?.toISOString()).toBe('2026-09-03T10:00:00.000Z');
  });
});
