import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NotificationPushStatusDto,
  NotificationPushTriggerDto,
  NotificationRuleDto,
  PushLogDto,
} from '@epgs/shared-types';
import { formatTimestamp, friendlyError, listPushLogs } from './notificationApi';

interface PushLogsDialogProps {
  /** 查看的规则；标题展示其名称。 */
  rule: NotificationRuleDto;
  onClose(): void;
}

const PAGE_SIZE = 20;

function triggerLabel(trigger: NotificationPushTriggerDto): string {
  return trigger === 'SCHEDULED' ? '定时' : '手动';
}

function statusLabel(status: NotificationPushStatusDto | null): string {
  switch (status) {
    case 'SUCCESS':
      return '成功';
    case 'PARTIAL':
      return '部分成功';
    case 'FAILED':
      return '失败';
    default:
      return '进行中';
  }
}

/** 规则「日志」子弹窗：拉取该规则的所有推送记录（定时+手动），可展开逐渠道送达明细。 */
export function PushLogsDialog({ rule, onClose }: PushLogsDialogProps): JSX.Element {
  const [logs, setLogs] = useState<PushLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 展开查看逐渠道送达明细的 push_log id
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listPushLogs(rule.id, { page, pageSize: PAGE_SIZE });
      setLogs(response.items);
      setTotal(response.total);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [rule.id, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    dialogRef.current?.focus();
    // Escape 关闭子对话框；父弹窗（NotificationModal）检测到子对话框打开时不处理 Escape，
    // 避免一次按键同时关闭两层弹窗。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleDetail(id: string): void {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div
      className="notification-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="notification-modal notification-modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-logs-title"
        tabIndex={-1}
      >
        <header className="notification-modal__header">
          <div>
            <p className="notification-modal__eyebrow">内镜中心 · 消息推送配置</p>
            <h2 id="push-logs-title">推送日志</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭推送日志"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="notification-log-subtitle">规则「{rule.name}」</div>

        {error && (
          <div className="feedback feedback--error" role="alert">
            {error}
            <button type="button" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}

        <div className="rules-table-wrap notification-log-wrap">
          {loading ? (
            <div className="rules-state">正在加载推送日志…</div>
          ) : error && logs.length === 0 ? (
            <div className="rules-state">
              <p>日志加载失败</p>
              <button className="button" type="button" onClick={() => void load()}>
                重新加载
              </button>
            </div>
          ) : logs.length === 0 ? (
            <div className="rules-state">
              <p>暂无推送记录</p>
              <span>该规则还没有执行过；定时到达或点击「立即执行一次」后这里会出现记录。</span>
            </div>
          ) : (
            <table className="rules-table notification-log-table">
              <thead>
                <tr>
                  <th>推送日期</th>
                  <th>触发</th>
                  <th>状态</th>
                  <th>开始时间</th>
                  <th>完成时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <LogRow
                    key={log.id}
                    log={log}
                    expanded={expandedId === log.id}
                    onToggle={() => toggleDetail(log.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
          {!loading && total > 0 && (
            <nav className="rules-pagination" aria-label="推送日志分页">
              <button
                className="button"
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  setPage((current) => Math.max(1, current - 1));
                  setExpandedId(null);
                }}
              >
                上一页
              </button>
              <span>
                第 {page} / {pageCount} 页
              </span>
              <button
                className="button"
                type="button"
                disabled={page >= pageCount}
                onClick={() => {
                  setPage((current) => Math.min(pageCount, current + 1));
                  setExpandedId(null);
                }}
              >
                下一页
              </button>
            </nav>
          )}
        </div>
      </section>
    </div>
  );
}

function LogRow({
  log,
  expanded,
  onToggle,
}: {
  log: PushLogDto;
  expanded: boolean;
  onToggle(): void;
}): JSX.Element {
  return (
    <>
      <tr>
        <td>
          <strong>{log.windowDate}</strong>
        </td>
        <td>{triggerLabel(log.trigger)}</td>
        <td>
          <span
            className={`notification-status ${
              log.status === 'SUCCESS'
                ? 'notification-status--ok'
                : log.status === 'PARTIAL'
                  ? 'notification-status--partial'
                  : log.status === 'FAILED'
                    ? 'notification-status--bad'
                    : 'notification-status--pending'
            }`}
          >
            {statusLabel(log.status)}
          </span>
        </td>
        <td>{formatTimestamp(log.startedAt)}</td>
        <td>{log.finishedAt ? formatTimestamp(log.finishedAt) : '-'}</td>
        <td>
          <button
            className="text-button"
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? '收起明细' : '渠道明细'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="notification-log-detail-row">
          <td colSpan={6}>
            {log.deliveries.length === 0 ? (
              <p className="notification-option-error">本次未产生逐渠道送达记录。</p>
            ) : (
              <table className="notification-delivery-table">
                <thead>
                  <tr>
                    <th>渠道</th>
                    <th>状态</th>
                    <th>错误信息</th>
                    <th>发送时间</th>
                  </tr>
                </thead>
                <tbody>
                  {log.deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>{delivery.channelName}</td>
                      <td>
                        <span
                          className={`notification-status ${
                            delivery.status === 'SUCCESS'
                              ? 'notification-status--ok'
                              : 'notification-status--bad'
                          }`}
                        >
                          {delivery.status === 'SUCCESS' ? '成功' : '失败'}
                        </span>
                      </td>
                      <td>{delivery.wecomErrMsg ?? '-'}</td>
                      <td>{delivery.sentAt ? formatTimestamp(delivery.sentAt) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
