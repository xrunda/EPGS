import { Injectable } from '@nestjs/common';

/**
 * Injectable wall-clock so sync logic (cursor computation, look-back
 * windows, health staleness checks) can be driven by a controllable
 * fake in tests instead of real `Date.now()`. This is what makes the
 * issue's "使用可控时钟验证跨日、时区与夏令时无关行为" requirement
 * testable without real sleeps or flaky wall-clock-dependent assertions.
 *
 * All timestamps produced/consumed here are plain `Date` objects (UTC
 * instants). "Asia/Shanghai 业务时区" only matters for DISPLAY/logging
 * formatting (see time-format.ts) - never for the underlying instant,
 * which avoids the classic timezone-arithmetic bug class entirely (China
 * has a single fixed UTC+8 offset with no DST, but this code does not
 * rely on that fact anywhere - it never adds/subtracts a "timezone
 * offset" from a Date at all).
 */
@Injectable()
export class SystemClock {
  now(): Date {
    return new Date();
  }
}

/** Simple fake clock for tests - construct with a starting time, advance explicitly. */
export class FakeClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
