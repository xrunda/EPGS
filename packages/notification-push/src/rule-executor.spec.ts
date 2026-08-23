import {
  NotificationRuleExecutor,
  NotificationRuleExecutorDeps,
  ExecuteRuleInput,
} from './rule-executor';
import { NotificationPushService } from './push.service';
import {
  NotificationRuleNotFoundError,
  ScheduledPushAlreadyExistsError,
} from './errors';
import { WecomWebhookError } from './wecom-webhook-sender';
import { PushRule, PushTrigger } from './types';

const NOW = new Date('2026-08-23T01:00:00Z'); // 09:00 Shanghai

function makeRule(overrides: Partial<PushRule> = {}): PushRule {
  return {
    id: 'rule-1',
    name: '每日 9 点',
    cron: '0 9 * * *',
    isEnabled: true,
    template: {
      id: 'template-1',
      msgType: 'TEXT',
      titleTemplate: null,
      contentTemplate: '{{totalCount}}',
      coverImageUrl: null,
      linkUrl: null,
      isEnabled: true,
    },
    channels: [
      {
        id: 'rc-1',
        channelId: 'channel-1',
        channel: { id: 'channel-1', name: '总值班室群', webhookUrlCiphertext: 'x', isEnabled: true },
      },
      {
        id: 'rc-2',
        channelId: 'channel-2',
        channel: { id: 'channel-2', name: '护理部群', webhookUrlCiphertext: 'x', isEnabled: true },
      },
    ],
    ...overrides,
  };
}

function makeStore(rule: PushRule | null = makeRule()): Record<string, jest.Mock> {
  return {
    getRule: jest.fn(async () => rule),
    findScheduledPush: jest.fn(async () => null),
    createPushLog: jest.fn(async (input: Record<string, unknown>) => ({
      id: 'log-1',
      ...input,
      status: null,
      errorSummary: null,
      finishedAt: null,
    })),
    createPushDelivery: jest.fn(async (input: Record<string, unknown>) => ({
      id: `delivery-${String(input.channelId)}`,
    })),
    completePushLog: jest.fn(async () => undefined),
  };
}

function makePush(outcome: () => Promise<Record<string, unknown>>): { pushToChannel: jest.Mock } {
  return {
    pushToChannel: jest.fn(outcome),
  };
}

function build(
  store: ReturnType<typeof makeStore>,
  push: ReturnType<typeof makePush>,
): NotificationRuleExecutor {
  const deps: NotificationRuleExecutorDeps = { store: store as never, push: push as unknown as NotificationPushService };
  return new NotificationRuleExecutor(deps);
}

function successOutcome() {
  return async (): Promise<Record<string, unknown>> => ({
    success: true,
    renderedTitle: '',
    renderedContent: '7',
    sentAt: '2026-08-23T01:00:01Z',
  });
}

function input(overrides: Partial<ExecuteRuleInput> = {}): ExecuteRuleInput {
  return { ruleId: 'rule-1', trigger: 'MANUAL', now: NOW, ...overrides };
}

describe('NotificationRuleExecutor.execute', () => {
  it('returns alreadyPushed and sends nothing when today\'s SCHEDULED run already exists', async () => {
    const store = makeStore();
    store.findScheduledPush.mockResolvedValue({ id: 'log-existing', ruleId: 'rule-1', windowDate: '2026-08-23', trigger: 'SCHEDULED', status: 'SUCCESS', errorSummary: null, startedAt: NOW, finishedAt: NOW });
    const push = makePush(successOutcome());
    const executor = build(store, push);

    const result = await executor.execute(input({ trigger: 'SCHEDULED' }));

    expect(result).toMatchObject({ alreadyPushed: true, pushLogId: 'log-existing', status: null, deliveries: [] });
    expect(store.createPushLog).not.toHaveBeenCalled();
    expect(push.pushToChannel).not.toHaveBeenCalled();
  });

  it('proceeds for MANUAL even when a SCHEDULED push already ran today (dedup only constrains SCHEDULED)', async () => {
    const store = makeStore();
    store.findScheduledPush.mockResolvedValue({ id: 'log-existing', ruleId: 'rule-1', windowDate: '2026-08-23', trigger: 'SCHEDULED', status: 'SUCCESS', errorSummary: null, startedAt: NOW, finishedAt: NOW });
    const push = makePush(successOutcome());
    const executor = build(store, push);

    const result = await executor.execute(input({ trigger: 'MANUAL' }));

    expect(result.alreadyPushed).toBe(false);
    expect(store.createPushLog).toHaveBeenCalledTimes(1);
    expect(push.pushToChannel).toHaveBeenCalledTimes(2);
  });

  it('aggregates SUCCESS when every channel sends; completePushLog gets errorSummary null', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    const executor = build(store, push);

    const result = await executor.execute(input());

    expect(result.status).toBe('SUCCESS');
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.every((d) => d.status === 'SUCCESS')).toBe(true);
    expect(store.completePushLog).toHaveBeenCalledWith(
      expect.objectContaining({ pushLogId: 'log-1', status: 'SUCCESS', errorSummary: null }),
    );
  });

  it('aggregates PARTIAL when one channel fails and the other succeeds', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    push.pushToChannel.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key'));
    const executor = build(store, push);

    const result = await executor.execute(input());

    expect(result.status).toBe('PARTIAL');
    expect(result.deliveries.map((d) => d.status)).toEqual(['FAILED', 'SUCCESS']);
    expect(result.deliveries[0]).toMatchObject({
      channelName: '总值班室群',
      wecomErrCode: 93000,
      wecomErrMsg: 'invalid webhook key',
      sentAt: null,
    });
    expect(store.completePushLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PARTIAL', errorSummary: 'invalid webhook key' }),
    );
  });

  it('aggregates FAILED when every channel fails', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    push.pushToChannel.mockRejectedValue(new Error('network down'));
    const executor = build(store, push);

    const result = await executor.execute(input());

    expect(result.status).toBe('FAILED');
    expect(result.deliveries.map((d) => d.status)).toEqual(['FAILED', 'FAILED']);
    expect(store.completePushLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', errorSummary: expect.any(String) }),
    );
  });

  it('truncates long WeCom errmsg and generic failure messages to the column width', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    push.pushToChannel.mockRejectedValue(new Error('x'.repeat(300)));
    const executor = build(store, push);

    await executor.execute(input());

    const completeCall = store.completePushLog.mock.calls[0][0] as { errorSummary: string };
    expect(completeCall.errorSummary.length).toBeLessThanOrEqual(500);
    const delivery = store.createPushDelivery.mock.calls[0][0] as { wecomErrMsg: string };
    expect(delivery.wecomErrMsg.length).toBeLessThanOrEqual(255);
  });

  it('treats a P2002 race (ScheduledPushAlreadyExistsError) as already pushed', async () => {
    const store = makeStore();
    store.createPushLog.mockRejectedValue(new ScheduledPushAlreadyExistsError('rule-1', '2026-08-23'));
    const push = makePush(successOutcome());
    const executor = build(store, push);

    const result = await executor.execute(input({ trigger: 'SCHEDULED' }));

    expect(result).toMatchObject({ alreadyPushed: true, pushLogId: null, status: null });
    expect(push.pushToChannel).not.toHaveBeenCalled();
    expect(store.completePushLog).not.toHaveBeenCalled();
  });

  it('rethrows a non-dedup createPushLog failure', async () => {
    const store = makeStore();
    store.createPushLog.mockRejectedValue(new Error('db exploded'));
    const push = makePush(successOutcome());
    const executor = build(store, push);

    await expect(executor.execute(input())).rejects.toThrow('db exploded');
  });

  it('injects windowDate into the push_log and each channel push', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    const executor = build(store, push);

    await executor.execute(input({ trigger: 'SCHEDULED', windowDate: '2026-08-22' }));

    expect(store.createPushLog).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule-1', windowDate: '2026-08-22', trigger: 'SCHEDULED' }),
    );
    expect(push.pushToChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1', windowDate: '2026-08-22' }),
    );
  });

  it('defaults windowDate to today (Shanghai) from the injected clock', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    const executor = build(store, push);

    await executor.execute(input());

    expect(store.createPushLog).toHaveBeenCalledWith(
      expect.objectContaining({ windowDate: '2026-08-23' }),
    );
  });

  it('throws NotificationRuleNotFoundError for a missing rule', async () => {
    const store = makeStore(null);
    const push = makePush(successOutcome());
    const executor = build(store, push);

    await expect(executor.execute(input())).rejects.toBeInstanceOf(NotificationRuleNotFoundError);
    expect(push.pushToChannel).not.toHaveBeenCalled();
  });

  it('exposes the trigger type on the created push_log', async () => {
    const store = makeStore();
    const push = makePush(successOutcome());
    const executor = build(store, push);

    await executor.execute(input({ trigger: 'MANUAL' }));

    expect(store.createPushLog).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'MANUAL' as PushTrigger }),
    );
  });
});
