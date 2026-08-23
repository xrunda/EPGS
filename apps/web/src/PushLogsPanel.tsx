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

/** 一级「日志」tab：聚合所有规则/模板的推送记录，逐渠道送达明细直接摊平进表格列。 */
export function PushLogsPanel(): JSX.Element {
  const [logs, setLogs] = useState<PushLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
                  <th>渠道送达</th>
                  <th>错误信息</th>
                  <th>开始时间</th>
                  <th>完成时间</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <LogRow key={log.id} log={log} />
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
                onClick={() => setPage((current) => Math.max(1, current - 1))}
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
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
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

function LogRow({ log }: { log: PushLogDto }): JSX.Element {
  return (
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
      <td>
        {log.deliveries.length === 0 ? (
          '-'
        ) : (
          <ul className="notification-run-deliveries notification-run-deliveries--flat">
            {log.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <span
                  className={`notification-status ${
                    delivery.status === 'SUCCESS'
                      ? 'notification-status--ok'
                      : 'notification-status--bad'
                  }`}
                >
                  {delivery.status === 'SUCCESS' ? '成功' : '失败'}
                </span>
                <span>{delivery.channelName}</span>
                {delivery.wecomErrMsg && <small>{delivery.wecomErrMsg}</small>}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>{log.errorSummary ?? '-'}</td>
      <td>{formatTimestamp(log.startedAt)}</td>
      <td>{log.finishedAt ? formatTimestamp(log.finishedAt) : '-'}</td>
    </tr>
  );
}
