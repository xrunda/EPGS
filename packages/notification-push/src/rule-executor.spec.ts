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
import { AlertLinkIssuer } from './alert-link';

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
  nowProvider?: () => Date,
): NotificationRuleExecutor {
  const deps: NotificationRuleExecutorDeps = {
    store: store as never,
    push: push as unknown as NotificationPushService,
    ...(nowProvider ? { nowProvider } : {}),
  };
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

  it('stamps finishedAt with the real completion clock, not the injected now anchor', async () => {
    // Regression: the worker's scheduler passes a fixed tick `now` (used for
    // startedAt + window date). finishedAt must NOT reuse it - that froze
    // finishedAt == startedAt even though the channel pushes take real time.
    const completedAt = new Date('2026-08-23T01:00:02Z');
    const store = makeStore();
    const push = makePush(successOutcome());
    const executor = build(store, push, () => completedAt);

    await executor.execute(input());

    expect(store.createPushLog).toHaveBeenCalledWith(
      expect.objectContaining({ startedAt: NOW }),
    );
    expect(store.completePushLog).toHaveBeenCalledWith(
      expect.objectContaining({ finishedAt: completedAt }),
    );
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

  describe('alert links (issue #72)', () => {
    const cards = [
      { level: 'RED' as const, count: 2, title: '红色关注 2 例 · 2026-08-23', description: 'd', url: 'http://h/alert?t=a', coverUrl: 'http://h/hospital-logo.jpg' },
    ];

    function makeIssuer(overrides: Partial<{ enabled: boolean; issue: jest.Mock }> = {}) {
      return { enabled: true, issue: jest.fn(async () => cards), ...overrides };
    }

    function buildWithIssuer(
      store: ReturnType<typeof makeStore>,
      push: ReturnType<typeof makePush>,
      issuer: ReturnType<typeof makeIssuer>,
    ): NotificationRuleExecutor {
      return new NotificationRuleExecutor({
        store: store as never,
        push: push as unknown as NotificationPushService,
        alertLinks: issuer as unknown as AlertLinkIssuer,
      });
    }

    it('issues the links ONCE per run (after the push_log exists) and passes the same cards to every channel', async () => {
      const store = makeStore();
      const push = makePush(successOutcome());
      const issuer = makeIssuer();

      const result = await buildWithIssuer(store, push, issuer).execute(input({ scope: ['内镜中心'] }));

      expect(issuer.issue).toHaveBeenCalledTimes(1);
      expect(issuer.issue).toHaveBeenCalledWith({
        windowDate: '2026-08-23',
        pushLogId: 'log-1',
        scope: ['内镜中心'],
        now: NOW,
      });
      expect(push.pushToChannel).toHaveBeenCalledTimes(2);
      for (const call of push.pushToChannel.mock.calls) {
        expect(call[0]).toMatchObject({ alertCards: cards });
      }
      expect(result.alertLinks).toEqual({ issued: 1, error: null });
      expect(result.status).toBe('SUCCESS');
    });

    it('passes no alertCards when the issuer returns none (all levels empty)', async () => {
      const store = makeStore();
      const push = makePush(successOutcome());
      const issuer = makeIssuer({ issue: jest.fn(async () => []) });

      const result = await buildWithIssuer(store, push, issuer).execute(input());

      expect(push.pushToChannel.mock.calls[0][0]).not.toHaveProperty('alertCards');
      expect(result.alertLinks).toEqual({ issued: 0, error: null });
    });

    it('skips issuance entirely when the issuer is disabled or absent', async () => {
      const store = makeStore();
      const push = makePush(successOutcome());
      const issuer = makeIssuer({ enabled: false });

      const withDisabled = await buildWithIssuer(store, push, issuer).execute(input());
      const without = await build(makeStore(), makePush(successOutcome())).execute(input());

      expect(issuer.issue).not.toHaveBeenCalled();
      expect(withDisabled.alertLinks).toEqual({ issued: 0, error: null });
      expect(without.alertLinks).toEqual({ issued: 0, error: null });
    });

    it('degrades to "no cards" and still pushes the template message when issuance throws', async () => {
      const store = makeStore();
      const push = makePush(successOutcome());
      const issuer = makeIssuer({ issue: jest.fn(async () => { throw new Error('db down'); }) });

      const result = await buildWithIssuer(store, push, issuer).execute(input());

      expect(push.pushToChannel).toHaveBeenCalledTimes(2);
      expect(push.pushToChannel.mock.calls[0][0]).not.toHaveProperty('alertCards');
      expect(result.status).toBe('SUCCESS');
      expect(result.alertLinks).toEqual({ issued: 0, error: 'db down' });
    });

    it('does not issue links for a deduped SCHEDULED run', async () => {
      const store = makeStore();
      store.findScheduledPush.mockResolvedValue({ id: 'log-existing', ruleId: 'rule-1', windowDate: '2026-08-23', trigger: 'SCHEDULED', status: 'SUCCESS', errorSummary: null, startedAt: NOW, finishedAt: NOW });
      const issuer = makeIssuer();

      const result = await buildWithIssuer(store, makePush(successOutcome()), issuer).execute(input({ trigger: 'SCHEDULED' }));

      expect(issuer.issue).not.toHaveBeenCalled();
      expect(result.alertLinks).toEqual({ issued: 0, error: null });
    });

    it('records a FAILED delivery carrying the "正文已发送" reason when only the cards fail on a channel', async () => {
      const store = makeStore();
      let call = 0;
      const push = makePush(async () => {
        call += 1;
        if (call === 2) throw new WecomWebhookError(45009, '正文已发送，关注卡片发送失败: api freq out of limit');
        return { success: true, renderedTitle: '', renderedContent: '7', sentAt: '2026-08-23T01:00:01Z' };
      });

      const result = await buildWithIssuer(store, push, makeIssuer()).execute(input());

      expect(result.status).toBe('PARTIAL');
      expect(result.deliveries[1]).toMatchObject({
        status: 'FAILED',
        wecomErrCode: 45009,
        wecomErrMsg: '正文已发送，关注卡片发送失败: api freq out of limit',
      });
    });
  });
});
