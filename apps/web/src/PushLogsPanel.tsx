import { useCallback, useEffect, useState } from 'react';
import type {
  NotificationPushStatusDto,
  NotificationPushTriggerDto,
  PushLogDto,
} from '@epgs/shared-types';
import { formatTimestamp, friendlyError, listAllPushLogs } from './notificationApi';

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

/** 一级「日志」tab：聚合所有规则/模板的推送记录，可展开逐渠道送达明细。 */
export function PushLogsPanel(): JSX.Element {
  const [logs, setLogs] = useState<PushLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 展开查看逐渠道送达明细的 push_log id
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAllPushLogs({ page, pageSize: PAGE_SIZE });
      setLogs(response.items);
      setTotal(response.total);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleDetail(id: string): void {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <>
      <div className="notification-toolbar">
        <p>
          共 <strong>{total}</strong> 条推送记录
        </p>
      </div>

      {error && (
        <div className="feedback feedback--error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="rules-content">
        <div className="rules-table-wrap">
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
              <span>还没有规则执行过；定时到达或点击规则行的「立即执行一次」后这里会出现记录。</span>
            </div>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>规则</th>
                  <th>模板</th>
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
      </div>
    </>
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
          <strong>{log.ruleName}</strong>
        </td>
        <td>{log.templateName}</td>
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
          <td colSpan={8}>
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
