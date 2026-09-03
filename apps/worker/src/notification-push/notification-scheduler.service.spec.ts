import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { formatShanghaiDate } from '@epgs/notification-push';
import { NotificationScheduler } from './notification-scheduler.service';
import { WorkerNotificationPushStore } from './worker-notification-push-store';
import { NotificationRuleExecutor } from '@epgs/notification-push';
import { AssistantEventsService } from '../assistant/assistant-events.service';

/**
 * Unit tests for NotificationScheduler's orchestration (tick cadence,
 * cron due-filtering, re-entrancy guard) using fakes for the store and the
 * executor - NOT full executor correctness (rendering/idempotency/status
 * aggregation), which is covered by @epgs/notification-push's rule-executor
 * spec and the worker e2e suite.
 */
describe('NotificationScheduler', () => {
  const DUE_AT = new Date('2026-08-23T09:00:30+08:00');

  function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      notificationTickSeconds: 60,
      ...overrides,
    };
    return { get: (key: string, def?: unknown) => values[key] ?? def } as unknown as ConfigService;
  }

  function makeRule(overrides: Record<string, unknown> = {}): any {
    return {
      id: 'rule-1',
      name: '每日 9 点',
      cron: '0 9 * * *',
      isEnabled: true,
      template: { id: 'template-1', msgType: 'TEXT', contentTemplate: '{{totalCount}}', titleTemplate: null, coverImageUrl: null, linkUrl: null, isEnabled: true },
      channels: [],
      ...overrides,
    };
  }

  function makeFakeStore(rules: any[] = []) {
    return { listEnabledRules: jest.fn().mockResolvedValue(rules) };
  }

  function makeFakeExecutor(overrides: Record<string, unknown> = {}) {
    return {
      execute: jest.fn().mockResolvedValue({
        alreadyPushed: false,
        pushLogId: 'log-1',
        windowDate: '2026-08-23',
        status: 'SUCCESS',
        deliveries: [],
        ...overrides,
      }),
    };
  }

  async function buildModule(
    store: any,
    executor: any,
    config: ConfigService,
  ): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        NotificationScheduler,
        { provide: ConfigService, useValue: config },
        { provide: WorkerNotificationPushStore, useValue: store },
        { provide: NotificationRuleExecutor, useValue: executor },
        {
          provide: AssistantEventsService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runDueRules() executes only the rules whose cron fires in the current Shanghai minute', async () => {
    const store = makeFakeStore([
      makeRule(), // 0 9 * * * - due at 09:00:30+08
      makeRule({ id: 'rule-2', name: '每日 8 点', cron: '0 8 * * *' }), // not due
    ]);
    const executor = makeFakeExecutor();
    const module = await buildModule(store, executor, makeConfig());
    const service = module.get(NotificationScheduler);

    const executed = await service.runDueRules(DUE_AT);

    expect(executed).toBe(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith({
      ruleId: 'rule-1',
      trigger: 'SCHEDULED',
      windowDate: formatShanghaiDate(DUE_AT),
      now: DUE_AT,
    });
  });

  it('does not count already-pushed dedups as executed', async () => {
    const store = makeFakeStore([makeRule()]);
    const executor = makeFakeExecutor({
      alreadyPushed: true,
      pushLogId: 'log-1',
      status: null,
      deliveries: [],
    });
    const module = await buildModule(store, executor, makeConfig());
    const service = module.get(NotificationScheduler);

    const executed = await service.runDueRules(DUE_AT);

    expect(executed).toBe(0);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('runDueRules() returns 0 and skips when a run is already in progress in this process', async () => {
    let resolveList: (v: any[]) => void = () => undefined;
    const store = {
      listEnabledRules: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveList = resolve;
          }),
      ),
    };
    const executor = makeFakeExecutor();
    const module = await buildModule(store, executor, makeConfig());
    const service = module.get(NotificationScheduler);

    const firstRun = service.runDueRules(DUE_AT);
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (store.listEnabledRules.mock.calls.length > 0) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });
    const secondRun = await service.runDueRules(DUE_AT);

    expect(secondRun).toBe(0);
    expect(executor.execute).not.toHaveBeenCalled();

    resolveList([]);
    await firstRun;
  });

  it('onModuleInit schedules the first tick using NOTIFICATION_TICK_SECONDS from config', async () => {
    jest.useFakeTimers();
    const module = await buildModule(makeFakeStore(), makeFakeExecutor(), makeConfig({ notificationTickSeconds: 30 }));
    const service = module.get(NotificationScheduler);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    service.onModuleInit();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    service.stop();
    setTimeoutSpy.mockRestore();
  });

  it('stop() clears the scheduled timer so no further ticks fire', async () => {
    jest.useFakeTimers();
    const store = makeFakeStore([makeRule()]);
    const executor = makeFakeExecutor();
    const module = await buildModule(store, executor, makeConfig({ notificationTickSeconds: 10 }));
    const service = module.get(NotificationScheduler);

    service.onModuleInit();
    service.stop();
    jest.advanceTimersByTime(10 * 60_000);
    await Promise.resolve();

    expect(store.listEnabledRules).not.toHaveBeenCalled();
  });
});
