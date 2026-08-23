import {
  CreatePushDeliveryInput,
  NotificationPushStore,
  PushDeliveryRow,
  PushLogRow,
} from './store';
import { NotificationPushService } from './push.service';
import { ExecuteRuleResult, PushDeliveryRecord, PushStatus, PushTrigger } from './types';
import { formatShanghaiDate } from './summary';
import { NotificationRuleNotFoundError, ScheduledPushAlreadyExistsError } from './errors';
import { WecomWebhookError } from './wecom-webhook-sender';

const MAX_WECOM_ERR_MSG = 255; // push_delivery.wecom_err_msg is VarChar(255)
const MAX_ERROR_SUMMARY = 500; // push_log.error_summary is free Text; cap for hygiene

/**
 * Executes a push rule across all of its channels (issue: push rules) - the
 * single path used by BOTH the api's manual "run now" and the worker's
 * scheduled tick, so a manual trigger and an automatic one behave
 * identically apart from idempotency and audit (see below).
 *
 * Flow per run:
 *   1. create a push_log row for (rule, windowDate, trigger)
 *   2. for each rule channel, pushToChannel; record a PushDelivery per
 *      channel (SUCCESS / FAILED + WeCom reason when WeCom rejected)
 *   3. aggregate the run status (SUCCESS / PARTIAL / FAILED) onto the
 *      push_log with finishedAt + errorSummary
 *
 * Idempotency (user decision #5): a rule's SCHEDULED push may run at most
 * once per (rule, windowDate) - guarded at the application layer
 * (findScheduledPush) AND at the DB layer (the partial unique index
 * uq_push_log_scheduled_dedup, whose P2002 conflict surfaces as
 * ScheduledPushAlreadyExistsError). MANUAL runs always proceed - the "run
 * now" button is the operator's explicit backstop and must stay freely
 * repeatable within a day.
 */
export interface NotificationRuleExecutorDeps {
  store: NotificationPushStore;
  push: NotificationPushService;
  /** Injectable clock for deterministic tests; defaults to real now. */
  nowProvider?: () => Date;
}

export interface ExecuteRuleInput {
  ruleId: string;
  trigger: PushTrigger;
  /** Shanghai YYYY-MM-DD summary window; defaults to today (Shanghai). */
  windowDate?: string;
  /**
   * Injectable clock (wins over nowProvider) for deterministic tests: anchors
   * the summary window date AND startedAt. finishedAt always uses the real
   * completion clock (this.nowProvider), never this anchor - otherwise a
   * scheduled run would stamp finishedAt == startedAt.
   */
  now?: Date;
  /** Department scope (empty = global), matching MonitorService.summary's contract. */
  scope?: string[];
}

export class NotificationRuleExecutor {
  private readonly nowProvider: () => Date;

  constructor(private readonly deps: NotificationRuleExecutorDeps) {
    this.nowProvider = deps.nowProvider ?? (() => new Date());
  }

  async execute(input: ExecuteRuleInput): Promise<ExecuteRuleResult> {
    const now = input.now ?? this.nowProvider();
    const windowDate = input.windowDate ?? formatShanghaiDate(now);

    const rule = await this.deps.store.getRule(input.ruleId);
    if (!rule) throw new NotificationRuleNotFoundError(input.ruleId);

    // App-layer dedup guard for SCHEDULED runs only (see class doc).
    if (input.trigger === 'SCHEDULED') {
      const existing = await this.deps.store.findScheduledPush(input.ruleId, windowDate);
      if (existing) {
        return {
          alreadyPushed: true,
          pushLogId: existing.id,
          windowDate,
          status: null,
          deliveries: [],
        };
      }
    }

    let pushLog: PushLogRow;
    try {
      pushLog = await this.deps.store.createPushLog({
        ruleId: input.ruleId,
        windowDate,
        trigger: input.trigger,
        startedAt: now,
      });
    } catch (error) {
      // DB race backstop: another worker process won the (rule, windowDate)
      // insert between the guard above and the create - treat as already pushed.
      if (error instanceof ScheduledPushAlreadyExistsError) {
        return {
          alreadyPushed: true,
          pushLogId: null,
          windowDate,
          status: null,
          deliveries: [],
        };
      }
      throw error;
    }

    const deliveries: PushDeliveryRecord[] = [];
    let anySuccess = false;
    let anyFailure = false;
    let errorSummary: string | null = null;

    for (const ruleChannel of rule.channels) {
      try {
        const outcome = await this.deps.push.pushToChannel({
          channelId: ruleChannel.channelId,
          templateId: rule.template.id,
          date: windowDate,
          windowDate,
          scope: input.scope,
        });
        anySuccess = true;
        const delivery = await this.recordDelivery(pushLog.id, {
          channelId: ruleChannel.channelId,
          status: 'SUCCESS',
          wecomErrCode: null,
          wecomErrMsg: null,
          sentAt: outcome.sentAt,
        });
        deliveries.push({
          id: delivery.id,
          channelId: ruleChannel.channelId,
          channelName: ruleChannel.channel.name,
          status: 'SUCCESS',
          wecomErrCode: null,
          wecomErrMsg: null,
          sentAt: outcome.sentAt,
        });
      } catch (error) {
        // Broad catch on purpose: any per-channel failure (missing/disabled
        // channel or template, WeCom rejection, network, or an unexpected
        // internal fault like a decrypt failure) must not abort the other
        // channels - it becomes a FAILED delivery and the run continues.
        anyFailure = true;
        const reason = toDeliveryFailure(error);
        const delivery = await this.recordDelivery(pushLog.id, {
          channelId: ruleChannel.channelId,
          status: 'FAILED',
          wecomErrCode: reason.wecomErrCode,
          wecomErrMsg: reason.wecomErrMsg,
          sentAt: null,
        });
        deliveries.push({
          id: delivery.id,
          channelId: ruleChannel.channelId,
          channelName: ruleChannel.channel.name,
          status: 'FAILED',
          wecomErrCode: reason.wecomErrCode,
          wecomErrMsg: reason.wecomErrMsg,
          sentAt: null,
        });
        if (errorSummary === null) errorSummary = reason.wecomErrMsg;
      }
    }

    const status: PushStatus =
      anySuccess && anyFailure ? 'PARTIAL' : anySuccess ? 'SUCCESS' : 'FAILED';
    const finalSummary = errorSummary ?? '所有渠道均发送失败';

    await this.deps.store.completePushLog({
      pushLogId: pushLog.id,
      status,
      // finishedAt is the REAL completion instant, never the injected clock
      // anchor: the scheduler's tick passes a fixed `now` (used for startedAt +
      // window date), and reusing it here would freeze finishedAt == startedAt
      // even though the actual channel pushes take real time.
      finishedAt: this.nowProvider(),
      errorSummary: status === 'SUCCESS' ? null : truncate(finalSummary, MAX_ERROR_SUMMARY),
    });

    return { alreadyPushed: false, pushLogId: pushLog.id, windowDate, status, deliveries };
  }

  private async recordDelivery(
    pushLogId: string,
    input: Omit<CreatePushDeliveryInput, 'pushLogId'>,
  ): Promise<PushDeliveryRow> {
    return this.deps.store.createPushDelivery({ ...input, pushLogId });
  }
}

function toDeliveryFailure(error: unknown): { wecomErrCode: number | null; wecomErrMsg: string } {
  if (error instanceof WecomWebhookError) {
    return {
      wecomErrCode: error.wecomErrCode,
      wecomErrMsg: truncate(error.wecomErrMsg || 'WeCom 发送失败', MAX_WECOM_ERR_MSG),
    };
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  return { wecomErrCode: null, wecomErrMsg: truncate(message, MAX_WECOM_ERR_MSG) };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
