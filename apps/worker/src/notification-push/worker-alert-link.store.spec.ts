import { WorkerAlertLinkStore } from './worker-alert-link.store';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the worker's AlertLinkStore adapter (issue #72) with a fake
 * Prisma client: the day-window + level filter, the per-level grouping, and
 * that only the token HASH (never a token) reaches the alert_link row.
 */
describe('WorkerAlertLinkStore', () => {
  function makePrisma(rows: { id: string; currentLevel: string }[] = []) {
    return {
      monitorRecord: { findMany: jest.fn(async (_args: unknown) => rows) },
      alertLink: { create: jest.fn(async (_args: unknown) => ({ id: 'link-1' })) },
    };
  }

  it('queries only ids inside the Shanghai day window at RED/YELLOW/GREEN and groups them by level', async () => {
    const prisma = makePrisma([
      { id: 'r1', currentLevel: 'RED' },
      { id: 'g1', currentLevel: 'GREEN' },
      { id: 'r2', currentLevel: 'RED' },
      { id: 'u1', currentLevel: 'UNCLASSIFIED' },
    ]);
    const store = new WorkerAlertLinkStore(prisma as unknown as PrismaService);

    const result = await store.listRecordIdsByLevel({
      windowDate: '2026-09-05',
      scope: ['ignored'],
    });

    expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith({
      where: {
        examTime: {
          gte: new Date('2026-09-05T00:00:00+08:00'),
          lt: new Date('2026-09-06T00:00:00+08:00'),
        },
        currentLevel: { in: ['RED', 'YELLOW', 'GREEN'] },
      },
      select: { id: true, currentLevel: true },
      orderBy: [{ examTime: 'desc' }, { id: 'asc' }],
    });
    // The worker is unscoped: no department condition regardless of `scope`.
    const query = prisma.monitorRecord.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).not.toHaveProperty('department');
    expect(result).toEqual({ RED: ['r1', 'r2'], GREEN: ['g1'] });
  });

  it('returns an empty object when the window has no classified records', async () => {
    const store = new WorkerAlertLinkStore(makePrisma([]) as unknown as PrismaService);
    expect(await store.listRecordIdsByLevel({ windowDate: '2026-09-05' })).toEqual({});
  });

  it('rejects an invalid window date before touching the database', async () => {
    const prisma = makePrisma();
    const store = new WorkerAlertLinkStore(prisma as unknown as PrismaService);
    await expect(store.listRecordIdsByLevel({ windowDate: '2026-02-31' })).rejects.toThrow(
      /Invalid date/,
    );
    expect(prisma.monitorRecord.findMany).not.toHaveBeenCalled();
  });

  it('persists the link row with the hash, level, window, push log, ids and expiry', async () => {
    const prisma = makePrisma();
    const store = new WorkerAlertLinkStore(prisma as unknown as PrismaService);
    const createdAt = new Date('2026-09-05T01:00:00Z');
    const expiresAt = new Date('2026-09-06T01:00:00Z');

    const result = await store.createAlertLink({
      tokenHash: 'a'.repeat(64),
      level: 'RED',
      windowDate: '2026-09-05',
      pushLogId: 'log-1',
      recordIds: ['r1', 'r2'],
      createdAt,
      expiresAt,
    });

    expect(result).toEqual({ id: 'link-1' });
    expect(prisma.alertLink.create).toHaveBeenCalledWith({
      data: {
        tokenHash: 'a'.repeat(64),
        level: 'RED',
        windowDate: '2026-09-05',
        pushLogId: 'log-1',
        recordIds: ['r1', 'r2'],
        createdAt,
        expiresAt,
      },
      select: { id: true },
    });
  });
});
