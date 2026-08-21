import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SyncJobStatus } from '@prisma/client';
import { SyncService } from './sync.service';
import { PACS_RIS_ADAPTER } from '../pacs-adapter/pacs-ris-adapter.interface';
import { PrismaService } from '../prisma/prisma.service';
import { SystemClock } from './clock';

/**
 * Unit tests for SyncService's orchestration behavior (scheduling,
 * re-entrancy guard, config wiring) using fakes for the adapter and
 * Prisma - NOT full sync-runner correctness (matching/upsert/idempotency
 * behavior), which is covered against a REAL Postgres instance in
 * apps/worker/test/sync.e2e-spec.ts per issue #6's verification
 * requirements. Mocking Prisma's `$transaction`/upsert/createMany
 * faithfully enough to trust matching+persistence correctness would
 * mostly re-implement Postgres in JS - not worth the risk of the mock
 * silently diverging from real constraint/upsert semantics.
 */
describe('SyncService', () => {
  function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      syncIntervalMinutes: 3,
      syncPageSize: 200,
      syncLookbackMinutes: 10,
      syncMaxRetries: 5,
      syncRetryBaseDelayMs: 1000,
      ...overrides,
    };
    return { get: (key: string, def?: unknown) => values[key] ?? def } as unknown as ConfigService;
  }

  function makeFakePrisma() {
    return {
      syncJobLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'job-1', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      },
      monitorRule: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
  }

  function makeFakeAdapter(items: unknown[] = []) {
    return {
      fetchReports: jest.fn().mockResolvedValue({ items, nextCursor: undefined }),
    };
  }

  async function buildModule(prisma: any, adapter: any, config: ConfigService): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        SyncService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: PACS_RIS_ADAPTER, useValue: adapter },
        SystemClock,
      ],
    }).compile();
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runOnce() runs a sync pass and returns a SUCCEEDED summary when there is nothing to read', async () => {
    const prisma = makeFakePrisma();
    const adapter = makeFakeAdapter([]);
    const module = await buildModule(prisma, adapter, makeConfig());
    const service = module.get(SyncService);

    const summary = await service.runOnce();

    expect(summary).not.toBeNull();
    expect(summary?.status).toBe(SyncJobStatus.SUCCEEDED);
    expect(summary?.readCount).toBe(0);
    expect(adapter.fetchReports).toHaveBeenCalledTimes(1);
  });

  it('runOnce() returns null and skips when a run is already in progress in this process', async () => {
    const prisma = makeFakePrisma();
    let resolveFetch: (v: { items: unknown[]; nextCursor?: string }) => void = () => undefined;
    const adapter = {
      fetchReports: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    };
    const module = await buildModule(prisma, adapter, makeConfig());
    const service = module.get(SyncService);

    const firstRun = service.runOnce();
    // Wait until the first run has actually reached fetchReports (i.e.
    // set `running = true` and gotten past its own await points) before
    // issuing the second call - a single microtask tick isn't enough
    // since runSync awaits prisma.syncJobLog.create() and
    // monitorRule.findMany() first.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (adapter.fetchReports.mock.calls.length > 0) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });
    const secondRun = await service.runOnce();

    expect(secondRun).toBeNull();

    resolveFetch({ items: [], nextCursor: undefined });
    await firstRun;
  });

  it('onModuleInit schedules the first tick using SYNC_INTERVAL_MINUTES from config', async () => {
    jest.useFakeTimers();
    const prisma = makeFakePrisma();
    const adapter = makeFakeAdapter([]);
    const module = await buildModule(prisma, adapter, makeConfig({ syncIntervalMinutes: 4 }));
    const service = module.get(SyncService);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    service.onModuleInit();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4 * 60_000);
    service.stop();
    setTimeoutSpy.mockRestore();
  });

  it('stop() clears the scheduled timer so no further ticks fire', async () => {
    jest.useFakeTimers();
    const prisma = makeFakePrisma();
    const adapter = makeFakeAdapter([]);
    const module = await buildModule(prisma, adapter, makeConfig({ syncIntervalMinutes: 1 }));
    const service = module.get(SyncService);

    service.onModuleInit();
    service.stop();
    jest.advanceTimersByTime(10 * 60_000);
    await Promise.resolve();

    expect(adapter.fetchReports).not.toHaveBeenCalled();
  });
});
