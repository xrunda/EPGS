import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorLevelConflictTodoDto } from '@epgs/shared-types';
import { LEVEL_CONFLICT_DAY_PRESETS, LEVEL_CONFLICT_DEFAULT_DAYS } from '@epgs/shared-types';
// 等级文字只有一个来源（attentionSource.ts），与工作台列表、详情抽屉、语义配置页
// 共用同一份映射 —— 同一屏里一处写「红色」、一处写「红色关注」是最费解的。
import { ATTENTION_LEVEL_LABELS } from './attentionSource';
import { FIELD_LABELS } from './highlight';
import {
  LevelConflictsApiError,
  listLevelConflicts,
  markLevelConflictRead,
} from './levelConflictsApi';
import './LevelConflictsModal.css';

/**
 * 关注等级分歧（issue #103）—— 管理面核对用的待办列表。
 *
 * 一份报告里同一处病变，两边给出了不同的关注等级：关键词规则说红色、整份报告
 * 核对说黄色。两边都算数（等级取较高的那个），所以记录本身没错，错的是配置 ——
 * 要么规则的等级划高了，要么那条情况的等级划低了，得有人看一眼才能定。
 *
 * 这一页存在的理由：在它之前，这种矛盾在医生端表现为「依据列表里一条红、一条黄
 * 并排」，读起来像两条互相印证的独立理由；管理员端则完全没有入口，没有任何人
 * 被要求去看它。医生端现在有一句只读提醒（DetailDrawer.tsx），这一页是给配置
 * 者的那一半：哪两组配置对不上、影响多少条记录、有没有人已经看过了。
 *
 * 三件事刻意如此：
 *   - 不落副本。列表每次用同一套判定从既有记录实算，这一页只存「看过了」这一个
 *     状态（monitor_level_conflict_read）。判定只有一份实现，两端共用。
 *   - 键用配置组而不是版本行。规则改版不会让已核对过的一条诈尸；等级改了才算
 *     另一件事（那是真的换了一种分歧）。
 *   - 「已读」只记录有人核对过这组配置，不表示任何报告被阅读或处置。本页不含
 *     任何患者信息：只有关键词、配置名、两个等级、一个列名和两个数字。
 */

interface LevelConflictsModalProps {
  open: boolean;
  onClose: () => void;
  /** RULE_ADMIN 才能标已读；只读用户看不到写操作（服务端同样会拦）。 */
  canMarkRead?: boolean;
}

type ReadFilter = '' | 'true' | 'false';

function friendlyError(error: unknown): string {
  if (error instanceof LevelConflictsApiError) {
    if (error.status === 403) return '当前账号没有核对该列表的权限。';
    return error.message;
  }
  return '请求失败，请检查网络后重试。';
}

/** Formats an ISO UTC instant as Asia/Shanghai wall time `YYYY-MM-DD HH:mm`. */
function formatSeenAt(iso: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function LevelConflictsModal({
  open,
  onClose,
  canMarkRead = true,
}: LevelConflictsModalProps): JSX.Element | null {
  const [items, setItems] = useState<MonitorLevelConflictTodoDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [days, setDays] = useState<number>(LEVEL_CONFLICT_DEFAULT_DAYS);
  const [readFilter, setReadFilter] = useState<ReadFilter>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);

  const query = useMemo(
    () => ({
      days,
      read: readFilter === '' ? undefined : readFilter === 'true',
    }),
    [days, readFilter],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listLevelConflicts(query);
      setItems(response.items);
      setUnreadCount(response.unreadCount);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, reloadKey]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const requestClose = useCallback(() => {
    setNotice(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open) return null;

  /**
   * 标记一组的已读状态。响应回的是「现在是什么状态」，所以只更新这一行，不重取
   * 整个列表 —— 列表里的顺序和窗口都不会因为标记动作而改变，重取只会让表格跳一下。
   * 未读计数跟着本地算，规则与服务端一致（readAt === null 即未读）。
   */
  async function toggleRead(item: MonitorLevelConflictTodoDto): Promise<void> {
    const nextRead = item.readAt === null;
    setBusyKey(item.conflictKey);
    setError(null);
    setNotice(null);
    try {
      const state = await markLevelConflictRead(item.conflictKey, nextRead);
      const updated = items.map((row) =>
        row.conflictKey === state.conflictKey ? { ...row, readAt: state.readAt } : row,
      );
      setItems(updated);
      setUnreadCount(updated.filter((row) => row.readAt === null).length);
      setNotice(nextRead ? '已标记为已读' : '已恢复为未读');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div
      className="level-conflict-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="level-conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="level-conflict-title"
        tabIndex={-1}
      >
        <header className="level-conflict-modal__header">
          <div>
            <p className="level-conflict-modal__eyebrow">内镜中心 · 配置核对</p>
            <h2 id="level-conflict-title">关注等级分歧</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭关注等级分歧"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        <div className="level-conflict-modal__notice">
          <span aria-hidden="true">i</span>
          <p>
            同一处病变，关键词规则和整份报告核对给出了<b>不同的关注等级</b>
            。两边都算数（记录取较高的那个），所以问题在配置不在报告 ——
            要么规则的等级划高了，要么这种情况的等级划低了，需要有人看一眼才能定。
          </p>
          <p>
            这里只统计配置组合，<b>不含任何患者信息</b>
            ；标记已读只记录有人核对过这组配置，与报告本身无关。
          </p>
        </div>

        <form
          className="rules-filters"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label>
            时间范围
            <select
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {LEVEL_CONFLICT_DAY_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  最近 {preset} 天
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={readFilter}
              onChange={(event) => setReadFilter(event.target.value as ReadFilter)}
            >
              <option value="">全部状态</option>
              <option value="false">未读</option>
              <option value="true">已读</option>
            </select>
          </label>
          <div className="rules-filters__actions">
            <button className="button" type="button" onClick={() => setReloadKey((c) => c + 1)}>
              刷新
            </button>
          </div>
        </form>

        <div className="rules-toolbar">
          <p>
            最近 {days} 天内共 <strong>{items.length}</strong> 组关注等级分歧，其中未读{' '}
            <strong>{unreadCount}</strong> 组
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
        {notice && (
          <div className="feedback feedback--success" role="status">
            {notice}
          </div>
        )}

        <div className="rules-content">
          <div className="rules-table-wrap">
            {loading ? (
              <div className="rules-state">正在统计关注等级分歧…</div>
            ) : error && items.length === 0 ? (
              <div className="rules-state">
                <p>关注等级分歧加载失败</p>
                <button className="button" type="button" onClick={() => void load()}>
                  重新加载
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="rules-state">
                <p>这段时间内没有发现关注等级分歧</p>
                <span>
                  没有分歧是常态：它意味着两边对同一处病变给了一致的关注等级。
                  可以放宽时间范围再看看更早的记录。
                </span>
              </div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>分歧的两条配置</th>
                    <th>出现位置</th>
                    <th>涉及记录</th>
                    <th>最近出现</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.conflictKey}>
                      <td className="level-conflict-table__pair">
                        <div>
                          <span
                            className={`level-tag level-tag--${item.keywordLevel.toLowerCase()}`}
                          >
                            {ATTENTION_LEVEL_LABELS[item.keywordLevel]}
                          </span>
                          <strong>{item.keyword}</strong>
                        </div>
                        <div>
                          <span
                            className={`level-tag level-tag--${item.semanticLevel.toLowerCase()}`}
                          >
                            {ATTENTION_LEVEL_LABELS[item.semanticLevel]}
                          </span>
                          <strong>{item.semanticName}</strong>
                        </div>
                      </td>
                      <td>
                        <span className="level-conflict-table__field">
                          {FIELD_LABELS[item.field]}
                        </span>
                      </td>
                      <td>
                        <strong>{item.recordCount}</strong> 条
                      </td>
                      <td className="level-conflict-table__meta">{formatSeenAt(item.lastSeenAt)}</td>
                      <td>
                        <span className={item.readAt ? 'status status--on' : 'status'}>
                          {item.readAt ? '已读' : '未读'}
                        </span>
                      </td>
                      <td>
                        {canMarkRead ? (
                          <div className="table-actions">
                            <button
                              type="button"
                              disabled={busyKey === item.conflictKey}
                              // 一行里两个名字才唯一：同一个关键词可以和不止一条
                              // 配置对不上，只报关键词的话屏幕阅读器听到的是两个
                              // 一模一样的按钮。
                              aria-label={`${item.readAt ? '标为未读' : '标为已读'}「${item.keyword}」与「${item.semanticName}」`}
                              onClick={() => void toggleRead(item)}
                            >
                              {item.readAt ? '标为未读' : '标为已读'}
                            </button>
                          </div>
                        ) : (
                          <span className="readonly-label">只读</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
