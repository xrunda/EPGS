import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AssistantHeartbeatService } from './assistant-heartbeat.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the assistant heartbeat loop (issue #70): the upsert
 * payload, the next-trigger computation over enabled rules, "未排程" when no
 * rule is enabled, and the retention sweep cadence. Fakes for Prisma - the
 * DB-level behavior is exercised by the api e2e suite.
 */
describe('AssistantHeartbeatService', () => {
  function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      assistantHeartbeatSeconds: 30,
      assistantEventRetentionDays: 7,
      ...overrides,
    };
    return { get: (key: string, def?: unknown) => values[key] ?? def } as unknown as ConfigService;
  }

  function makeFakePrisma(rules: { cron: string }[] = []) {
    return {
      assistantHeartbeat: { upsert: jest.fn().mockResolvedValue(undefined) },
      assistantEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationRule: { findMany: jest.fn().mockResolvedValue(rules) },
    };
  }

  async function build(prisma: any, config: ConfigService): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        AssistantHeartbeatService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
  }

  afterEach(() => jest.useRealTimers());

  it('onModuleInit writes an immediate heartbeat with lastSeenAt + runningSince', async () => {
    const prisma = makeFakePrisma();
    const module = await build(prisma, makeConfig());
    const service = module.get(AssistantHeartbeatService);

    await service.onModuleInit();
    service.stop();

    expect(prisma.assistantHeartbeat.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.assistantHeartbeat.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.create.lastSeenAt).toBeInstanceOf(Date);
    expect(call.create.runningSince).toBeInstanceOf(Date);
    expect(call.update.lastSeenAt).toBeInstanceOf(Date);
    // runningSince is rewritten on every beat so a restart resets it.
    expect(call.update.runningSince).toBe(call.create.runningSince);
  });

  it('computes nextTriggerAt as the earliest fire across enabled rules', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T09:00:00Z')); // 17:00 Shanghai
    // "0 18 * * *" -> today 18:00 (10:00Z); "0 8 * * *" -> tomorrow 08:00.
    const prisma = makeFakePrisma([{ cron: '0 8 * * *' }, { cron: '0 18 * * *' }]);
    const module = await build(prisma, makeConfig());
    const service = module.get(AssistantHeartbeatService);

    await service.onModuleInit();
    service.stop();

    const { nextTriggerAt } = prisma.assistantHeartbeat.upsert.mock.calls[0][0].create;
    expect((nextTriggerAt as Date).toISOString()).toBe('2026-09-03T10:00:00.000Z');
  });

  it('writes nextTriggerAt = null when no rule is enabled ("未排程")', async () => {
    const prisma = makeFakePrisma([]);
    const module = await build(prisma, makeConfig());
    const service = module.get(AssistantHeartbeatService);

    await service.onModuleInit();
    service.stop();

    expect(prisma.assistantHeartbeat.upsert.mock.calls[0][0].create.nextTriggerAt).toBeNull();
  });

  it('a malformed cron does not blank the countdown for the whole fleet — it just yields null', async () => {
    const prisma = makeFakePrisma([{ cron: 'not a cron' }]);
    const module = await build(prisma, makeConfig());
    const service = module.get(AssistantHeartbeatService);

    await service.onModuleInit();
    service.stop();

    expect(prisma.assistantHeartbeat.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.assistantHeartbeat.upsert.mock.calls[0][0].create.nextTriggerAt).toBeNull();
  });

  it('sweeps assistant_event rows older than the retention window every 20 ticks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
    const prisma = makeFakePrisma();
    const module = await build(prisma, makeConfig({ assistantEventRetentionDays: 7 }));
    const service = module.get(AssistantHeartbeatService);

    await service.onModuleInit(); // immediate beat, no sweep yet
    // 20 ticks -> one sweep.
    for (let i = 0; i < 20; i += 1) {
      await jest.advanceTimersByTimeAsync(30_000);
    }
    service.stop();

    expect(prisma.assistantEvent.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.assistantEvent.deleteMany.mock.calls[0][0].where;
    const cutoff = where.occurredAt.lt as Date;
    // cutoff is exactly 7 days before the sweep instant (20 ticks × 30s after 12:00Z).
    const sweptAt = new Date('2026-09-03T12:00:00Z').getTime() + 20 * 30_000;
    expect(cutoff.getTime()).toBe(sweptAt - 7 * 24 * 60 * 60 * 1000);
  });

  it('a heartbeat DB error is swallowed so the loop keeps beating', async () => {
    const prisma = makeFakePrisma();
    prisma.assistantHeartbeat.upsert
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
    const module = await build(prisma, makeConfig());
    const service = module.get(AssistantHeartbeatService);

    await expect(service.onModuleInit()).resolves.not.toThrow();
    await jest.advanceTimersByTimeAsync(30_000);
    service.stop();

    expect(prisma.assistantHeartbeat.upsert.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
