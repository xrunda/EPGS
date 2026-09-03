import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AssistantEventDto,
  PushAssistantLastRunDto,
  PushAssistantPreviewDto,
  PushAssistantStatusDto,
} from '@epgs/shared-types';
import { friendlyError, getPushAssistantStatus, runRule } from './notificationApi';
import './PushAssistantWidget.css';

/** Status poll cadence. Issue #70: 5s polling, no SSE in v1. */
const POLL_MS = 5000;

interface PushAssistantWidgetProps {
  /** Opens the notification modal on its 「日志」tab (the widget's「推送日志」link). */
  onOpenLogs(): void;
}

/**
 * The right-corner 推送助理 (issue #70): a two-layer always-on component - a
 * minimal pill (status dot + name + countdown) that expands into a full
 * panel. Shows the four things a duty-room operator needs to see at a glance:
 * is it alive, when does it push next, what did it just do, and a「立即推送」
 * button (reuses #61's run endpoint).
 *
 * Data comes from GET /api/notifications/assistant/status, polled every 5s.
 * The countdown re-computes locally each second from nextTriggerAt so it
 * ticks smoothly between polls.
 */
export function PushAssistantWidget({ onOpenLogs }: PushAssistantWidgetProps): JSX.Element | null {
  const [status, setStatus] = useState<PushAssistantStatusDto | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const pollRef = useRef<number>();

  const load = useCallback(async () => {
    try {
      const next = await getPushAssistantStatus();
      setStatus(next);
      setLoadError(false);
    } catch {
      // Keep the last-known status on the screen; just flag the staleness.
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    pollRef.current = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(pollRef.current);
  }, [load]);

  // Local 1s tick so the countdown moves between polls.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const handlePush = useCallback(async () => {
    if (!status || status.runnableRules.length === 0) return;
    const names = status.runnableRules.map((r) => r.name).join('、');
    if (
      !window.confirm(
        `立即推送「${names}」？将按当前（上海时区）新报告口径向企业微信群真实发送。`,
      )
    ) {
      return;
    }
    setPushing(true);
    setPushError(null);
    try {
      for (const rule of status.runnableRules) {
        await runRule(rule.id);
      }
      await load();
    } catch (err) {
      setPushError(friendlyError(err));
    } finally {
      setPushing(false);
    }
  }, [status, load]);

  if (!status) return null;

  const countdown = formatCountdown(status.nextTriggerAt, now);
  const offline = !status.online;
  const canPush = status.online && status.runnableRules.length > 0 && !pushing;

  const pillMeta = offline
    ? status.lastSeenAt
      ? `心跳 ${relativeTime(status.lastSeenAt, now)}`
      : '心跳未知'
    : status.nextTriggerAt
      ? shortTime(status.nextTriggerAt)
      : '未排程';

  return (
    <div
      className={`pa-widget${offline ? ' pa-widget--offline' : ''}`}
      data-expanded={expanded}
    >
      {expanded ? (
        <section className="pa-panel" aria-label="推送助理">
          <header className="pa-panel__head">
            <span
              className={`pa-dot${offline ? '' : ' pa-dot--pulse'}`}
              aria-hidden="true"
            />
            <span className="pa-panel__title">推送助理</span>
            <span className={`pa-chip pa-chip--${status.phase.toLowerCase()}`}>
              {phaseLabel(status.phase)}
            </span>
            <button
              type="button"
              className="pa-collapse"
              onClick={() => setExpanded(false)}
              aria-label="收起"
            >
              ‹
            </button>
          </header>

          <div className="pa-panel__body">
            {status.phase === 'OFFLINE' ? (
              <div className="pa-hero pa-hero--offline">
                <div className="pa-hero__label">推送助理失联</div>
                <div className="pa-hero__alarm">
                  最后一次心跳
                  {status.lastSeenAt ? ` ${relativeTime(status.lastSeenAt, now)}` : '时间未知'}
                </div>
                <div className="pa-hero__sub">异常期间停止推送 · 请检查 worker 进程</div>
              </div>
            ) : status.phase === 'JUST_DONE' && status.lastRun ? (
              <LastRunHero run={status.lastRun} countdown={countdown} />
            ) : (
              <OnDutyHero preview={status.preview} countdown={countdown} nextTriggerAt={status.nextTriggerAt} now={now} />
            )}

            <div className="pa-syncline">
              今日已同步 {status.todaySyncCount} 份
              {status.lastSyncAt ? ` · 最近 ${feedTime(status.lastSyncAt, now)}` : ''}
            </div>

            <div className="pa-sec">
              <div className="pa-sec__label">最近活动</div>
              <ActivityFeed events={status.events} now={now} />
            </div>

            {status.phase === 'JUST_DONE' && status.lastRun && status.lastRun.stages.length > 0 && (
              <ExecBar run={status.lastRun} />
            )}

            {loadError && <p className="pa-warn">状态更新暂时失败，显示的是上次数据</p>}
            {pushError && <p className="pa-warn">{pushError}</p>}

            <div className="pa-divider" />
          </div>

          <div className="pa-actions">
            <button
              type="button"
              className="pa-btn pa-btn--primary"
              onClick={() => void handlePush()}
              disabled={!canPush}
            >
              {pushing ? '推送中…' : '立即推送'}
            </button>
            <button type="button" className="pa-btn pa-btn--ghost" onClick={onOpenLogs}>
              推送日志
            </button>
          </div>

          <footer className="pa-foot">
            <span className="pa-foot__dot" aria-hidden="true" />
            <span>
              连续运行 {status.runningDays} 天
              {status.lastSeenAt ? ` · 心跳 ${relativeTime(status.lastSeenAt, now)}` : ''}
            </span>
          </footer>
        </section>
      ) : (
        <button
          type="button"
          className="pa-pill"
          onClick={() => setExpanded(true)}
          aria-label="展开推送助理"
        >
          <span className={`pa-dot${offline ? '' : ' pa-dot--pulse'}`} aria-hidden="true" />
          <span className="pa-pill__name">推送助理</span>
          <span className="pa-pill__divider" aria-hidden="true" />
          <span className="pa-pill__count">{offline ? '已失联' : countdown}</span>
          <span className={`pa-pill__meta${offline ? ' pa-pill__meta--alarm' : ''}`}>{pillMeta}</span>
          <span className="pa-pill__chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}
    </div>
  );
}

function OnDutyHero({
  preview,
  countdown,
  nextTriggerAt,
  now,
}: {
  preview: PushAssistantPreviewDto | null;
  countdown: string;
  nextTriggerAt: string | null;
  now: number;
}): JSX.Element {
  return (
    <div className="pa-hero">
      <div className="pa-hero__label">距下次推送</div>
      <div className="pa-hero__count">{countdown}</div>
      <div className="pa-hero__sub">
        {nextTriggerAt ? `${fullTime(nextTriggerAt, now)}` : '暂无启用的推送规则'}
      </div>
      {preview && (
        <div className="pa-hero__preview">
          预计推送 <b>红色 {preview.counts.red} 例</b>
          {preview.redKeywords !== '—' ? `（${preview.redKeywords}）` : ''}
          <br />
          {preview.windowDate} 新增 {preview.counts.total} 份 · 未分级 {preview.counts.unclassified} 份
        </div>
      )}
    </div>
  );
}

function LastRunHero({
  run,
  countdown,
}: {
  run: PushAssistantLastRunDto;
  countdown: string;
}): JSX.Element {
  return (
    <div className="pa-hero">
      <div className="pa-hero__label">
        本次推送{statusText(run.status)} · {run.ruleName}
      </div>
      <div className="pa-stat-grid">
        <Stat value={run.counts.red} label="红" tone="red" />
        <Stat value={run.counts.yellow} label="黄" />
        <Stat value={run.counts.green} label="绿" />
        <Stat value={run.counts.unclassified} label="未分级" />
        <Stat value={run.counts.total} label="共" />
      </div>
      <div className="pa-hero__sub">
        已通知 {run.groupCount} 个群 · 用时 {(run.elapsedMs / 1000).toFixed(1)} 秒
      </div>
      <div className="pa-hero__next">
        距下次推送 <span className="pa-mono">{countdown}</span>
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'red';
}): JSX.Element {
  return (
    <div className="pa-stat">
      <b className={tone === 'red' ? 'pa-stat__red' : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ActivityFeed({
  events,
  now,
}: {
  events: AssistantEventDto[];
  now: number;
}): JSX.Element {
  if (events.length === 0) {
    return <p className="pa-feed__empty">暂无活动记录</p>;
  }
  return (
    <div className="pa-feed">
      {events.map((event) => (
        <div className="pa-feed__row" key={event.id}>
          <span className="pa-feed__time">{feedTime(event.occurredAt, now)}</span>
          <span className={`pa-feed__dot pa-feed__dot--${feedTone(event)}`} aria-hidden="true" />
          <span className="pa-feed__text">{event.summary}</span>
        </div>
      ))}
    </div>
  );
}

function ExecBar({ run }: { run: PushAssistantLastRunDto }): JSX.Element {
  const total = run.stages.reduce((sum, s) => sum + s.elapsedMs, 0) || 1;
  return (
    <div className="pa-sec pa-exec">
      <div className="pa-sec__label">
        执行过程 · 本次推送 · 共 {(run.elapsedMs / 1000).toFixed(1)}s
      </div>
      <div className="pa-exec__bar">
        {run.stages.map((stage) => (
          <i
            key={stage.name}
            className={`pa-exec__seg pa-exec__seg--${stage.name}`}
            style={{ flexGrow: Math.max(1, Math.round((stage.elapsedMs / total) * 100)) }}
          />
        ))}
      </div>
      <div className="pa-exec__labels">
        {run.stages.map((stage) => (
          <span key={stage.name}>
            {stageLabel(stage.name)} {(stage.elapsedMs / 1000).toFixed(1)}s
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function phaseLabel(phase: PushAssistantStatusDto['phase']): string {
  switch (phase) {
    case 'ON_DUTY':
      return '值班中';
    case 'JUST_DONE':
      return '刚完成';
    case 'OFFLINE':
      return '已失联';
  }
}

function statusText(status: PushAssistantLastRunDto['status']): string {
  switch (status) {
    case 'SUCCESS':
      return '成功';
    case 'PARTIAL':
      return '部分成功';
    case 'FAILED':
      return '失败';
    default:
      return '完成';
  }
}

function stageLabel(name: string): string {
  return { sync: '同步', match: '匹配', render: '生成', deliver: '发出' }[name] ?? name;
}

function feedTone(event: AssistantEventDto): string {
  if (event.type === 'PUSH_DONE') return 'ok';
  // KEYWORD_HIT
  return event.detail.type === 'KEYWORD_HIT' && event.detail.level === 'RED' ? 'red' : 'yellow';
}

/** HH:MM:SS remaining until `iso`; "00:00:00" once past, "--:--:--" when null. */
function formatCountdown(iso: string | null, now: number): string {
  if (!iso) return '--:--:--';
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

const CN_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const CN_DATE = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
});

function shortTime(iso: string): string {
  return CN_TIME.format(new Date(iso));
}

/** "今天 18:00" / "明天 18:00" / "09-05 18:00" relative to `now` (Shanghai days). */
function fullTime(iso: string, now: number): string {
  const target = new Date(iso);
  const dayDiff = shanghaiDayDiff(now, target.getTime());
  const time = CN_TIME.format(target);
  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `明天 ${time}`;
  return `${CN_DATE.format(target)} ${time}`;
}

/** Feed timestamps: "HH:MM" today, "昨天 HH:MM", else "MM-DD HH:MM". */
function feedTime(iso: string, now: number): string {
  const t = new Date(iso);
  const dayDiff = shanghaiDayDiff(t.getTime(), now);
  const time = CN_TIME.format(t);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  return `${CN_DATE.format(t)} ${time}`;
}

function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  return `${hr} 小时前`;
}

/** Whole Shanghai-calendar-days between two instants (b's day − a's day). */
function shanghaiDayDiff(aMs: number, bMs: number): number {
  const key = (ms: number): number => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
    return Date.parse(`${parts}T00:00:00Z`);
  };
  return Math.round((key(bMs) - key(aMs)) / 86_400_000);
}
