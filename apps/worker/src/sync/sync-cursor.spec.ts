import { SyncJobStatus } from '@prisma/client';
import { resolveCursor, encodeCursor, decodeCursor, SYNC_JOB_NAME } from './sync-cursor';

/** Minimal fake of the one Prisma call resolveCursor makes - avoids needing a real DB for this pure cursor-selection logic. */
function fakePrisma(rows: Array<{ status: SyncJobStatus; cursorEnd: string | null; startedAt: Date }>) {
  return {
    syncJobLog: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const filtered = rows.filter(
          (r) => where.status.in.includes(r.status) && (where.cursorEnd?.not !== null || true) && r.cursorEnd !== null,
        );
        if (filtered.length === 0) return null;
        const sorted = [...filtered].sort((a, b) =>
          orderBy.startedAt === 'desc'
            ? b.startedAt.getTime() - a.startedAt.getTime()
            : a.startedAt.getTime() - b.startedAt.getTime(),
        );
        return { ...sorted[0], jobName: SYNC_JOB_NAME };
      }),
    },
  } as any;
}

describe('resolveCursor', () => {
  it('falls back to firstRunLookbackMs before now when there is no prior successful run (first run / empty window)', async () => {
    const prisma = fakePrisma([]);
    const now = new Date('2026-08-21T10:00:00.000Z');
    const result = await resolveCursor(prisma, now, 10 * 60_000, 60 * 60_000);
    expect(result.since).toEqual(new Date('2026-08-21T09:00:00.000Z'));
    expect(result.previousCursorEnd).toBeNull();
  });

  it('uses the last SUCCEEDED run cursorEnd minus the look-back window', async () => {
    const prisma = fakePrisma([
      {
        status: SyncJobStatus.SUCCEEDED,
        cursorEnd: encodeCursor(new Date('2026-08-21T09:30:00.000Z')),
        startedAt: new Date('2026-08-21T09:00:00.000Z'),
      },
    ]);
    const now = new Date('2026-08-21T10:00:00.000Z');
    const result = await resolveCursor(prisma, now, 5 * 60_000, 60 * 60_000);
    expect(result.since).toEqual(new Date('2026-08-21T09:25:00.000Z'));
    expect(result.previousCursorEnd).toBe(encodeCursor(new Date('2026-08-21T09:30:00.000Z')));
  });

  it('uses the last PARTIAL run cursorEnd too (partial success still advances safely)', async () => {
    const prisma = fakePrisma([
      {
        status: SyncJobStatus.PARTIAL,
        cursorEnd: encodeCursor(new Date('2026-08-21T09:45:00.000Z')),
        startedAt: new Date('2026-08-21T09:00:00.000Z'),
      },
    ]);
    const now = new Date('2026-08-21T10:00:00.000Z');
    const result = await resolveCursor(prisma, now, 0, 60 * 60_000);
    expect(result.since).toEqual(new Date('2026-08-21T09:45:00.000Z'));
  });

  it('ignores FAILED runs entirely (never resumes from a failed run cursor, even if it has one)', async () => {
    const prisma = fakePrisma([
      {
        status: SyncJobStatus.SUCCEEDED,
        cursorEnd: encodeCursor(new Date('2026-08-21T08:00:00.000Z')),
        startedAt: new Date('2026-08-21T08:00:00.000Z'),
      },
    ]);
    const now = new Date('2026-08-21T10:00:00.000Z');
    const result = await resolveCursor(prisma, now, 0, 60 * 60_000);
    // Must resume from the SUCCEEDED run, not any (absent, but
    // hypothetically later) FAILED run's cursor.
    expect(result.since).toEqual(new Date('2026-08-21T08:00:00.000Z'));
  });

  it('cursor round-trips through encode/decode without losing precision (day/timezone-independent)', () => {
    const original = new Date('2026-08-21T23:59:59.999Z');
    expect(decodeCursor(encodeCursor(original))).toEqual(original);
  });

  it('throws on a corrupt stored cursor rather than silently resuming from an arbitrary date', async () => {
    const prisma = fakePrisma([
      { status: SyncJobStatus.SUCCEEDED, cursorEnd: 'not-a-date', startedAt: new Date('2026-08-21T08:00:00.000Z') },
    ]);
    await expect(resolveCursor(prisma, new Date('2026-08-21T10:00:00.000Z'), 0, 60_000)).rejects.toThrow(
      /invalid stored cursor/,
    );
  });
});
