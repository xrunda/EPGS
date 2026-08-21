import { ConfigService } from '@nestjs/config';
import { SyncStatusService } from './sync-status.service';

describe('SyncStatusService', () => {
  function makePrisma(rows: { good: any; last: any }) {
    return {
      syncJobLog: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.status?.in) return rows.good;
          return rows.last;
        }),
      },
    } as any;
  }

  function makeConfig(syncIntervalMinutes = 3): ConfigService {
    return { get: () => syncIntervalMinutes } as unknown as ConfigService;
  }

  it('returns UNKNOWN when no sync_job_log rows exist at all', async () => {
    const prisma = makePrisma({ good: null, last: null });
    const service = new SyncStatusService(prisma, makeConfig());
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('UNKNOWN');
    expect(status.lastSuccessAt).toBeNull();
    expect(status.cursor).toBeNull();
  });

  it('returns HEALTHY when the last successful run finished recently (within the delayed threshold)', async () => {
    const finishedAt = new Date('2026-08-21T09:58:00Z'); // 2 min ago, interval=3min -> well within 3x
    const good = {
      finishedAt,
      startedAt: new Date('2026-08-21T09:57:00Z'),
      status: 'SUCCEEDED',
      cursorEnd: '2026-08-21T09:57:30.000Z',
      readCount: 5,
      successCount: 5,
      failureCount: 0,
      errorSummary: null,
    };
    const prisma = makePrisma({ good, last: good });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('HEALTHY');
    expect(status.cursor).toBe('2026-08-21T09:57:30.000Z');
    expect(status.lastRunStatus).toBe('SUCCEEDED');
  });

  it('returns DELAYED when the last success is older than the delayed threshold but within the failed threshold', async () => {
    // interval=3min -> delayed threshold 9min, failed threshold 24min. 12min stale -> DELAYED.
    const finishedAt = new Date('2026-08-21T09:48:00Z');
    const good = {
      finishedAt,
      startedAt: finishedAt,
      status: 'SUCCEEDED',
      cursorEnd: 'x',
      readCount: 1,
      successCount: 1,
      failureCount: 0,
      errorSummary: null,
    };
    const prisma = makePrisma({ good, last: good });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('DELAYED');
  });

  it('returns FAILED when the last success is older than the failed threshold', async () => {
    const finishedAt = new Date('2026-08-21T09:00:00Z'); // 60 min ago, failed threshold=24min
    const good = {
      finishedAt,
      startedAt: finishedAt,
      status: 'SUCCEEDED',
      cursorEnd: 'x',
      readCount: 1,
      successCount: 1,
      failureCount: 0,
      errorSummary: null,
    };
    const prisma = makePrisma({ good, last: good });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('FAILED');
  });

  it('returns FAILED when the most recent run status is FAILED and there is no successful run at all', async () => {
    const last = {
      status: 'FAILED',
      startedAt: new Date('2026-08-21T09:59:00Z'),
      readCount: 3,
      successCount: 0,
      failureCount: 3,
      errorSummary: 'batch failure at page 1: transient error',
    };
    const prisma = makePrisma({ good: null, last });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('FAILED');
    expect(status.errorSummary).toContain('transient error');
  });

  it('returns FAILED when a RUNNING row has been running far longer than expected (stuck/crashed)', async () => {
    const last = {
      status: 'RUNNING',
      startedAt: new Date('2026-08-21T09:00:00Z'), // 60 min ago, stuck threshold = 4*3=12min
      readCount: 0,
      successCount: 0,
      failureCount: 0,
      errorSummary: null,
    };
    const prisma = makePrisma({ good: null, last });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.health).toBe('FAILED');
  });

  it('never includes patient data - errorSummary passthrough is opaque to this service (sanitization happens at write time)', async () => {
    const good = {
      finishedAt: new Date('2026-08-21T09:59:00Z'),
      startedAt: new Date('2026-08-21T09:59:00Z'),
      status: 'PARTIAL',
      cursorEnd: 'x',
      readCount: 10,
      successCount: 9,
      failureCount: 1,
      errorSummary: 'reportId=RPT-1 accession=ACC-1: parse error',
    };
    const prisma = makePrisma({ good, last: good });
    const service = new SyncStatusService(prisma, makeConfig(3));
    const status = await service.getStatus(new Date('2026-08-21T10:00:00Z'));
    expect(status.errorSummary).toBe('reportId=RPT-1 accession=ACC-1: parse error');
    expect(status.failureCount).toBe(1);
  });
});
