import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateNotificationChannelBody,
  NotificationChannelDto,
  UpdateNotificationChannelBody,
} from '@epgs/shared-types';
import {
  createChannel,
  formatTimestamp,
  friendlyError,
  listChannels,
  updateChannel,
} from './notificationApi';

interface ChannelPanelProps {
  actorId: string;
  /** 后端 @RequireRoles(SYSTEM_ADMIN) 强校验；此处仅隐藏写入口（UX 优化）。 */
  canManageNotifications: boolean;
  /** 编辑器 dirty 状态上抛给父弹窗，门控切 tab 与关闭。 */
  onDirtyChange(dirty: boolean): void;
  onOpenTestSend(preselected: { channelId: string }): void;
}

interface ChannelFilters {
  enabled: '' | 'true' | 'false';
}

interface ChannelDraft {
  name: string;
  /** 编辑时恒为 ''（占位符"留空则不修改"），绝不回填掩码值。 */
  webhookUrl: string;
  isEnabled: boolean;
}

const EMPTY_FILTERS: ChannelFilters = { enabled: '' };
const EMPTY_CHANNEL: ChannelDraft = { name: '', webhookUrl: '', isEnabled: true };
const PAGE_SIZE = 20;

export function ChannelPanel({
  actorId,
  canManageNotifications,
  onDirtyChange,
  onOpenTestSend,
}: ChannelPanelProps): JSX.Element {
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<ChannelFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ChannelFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<NotificationChannelDto | 'new' | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_CHANNEL);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const query = useMemo(
    () => ({
      isEnabled: appliedFilters.enabled === '' ? undefined : appliedFilters.enabled === 'true',
      page,
      pageSize: PAGE_SIZE,
    }),
    [appliedFilters, page],
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listChannels(query);
      setChannels(response.items);
      setTotal(response.total);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate(): void {
    setEditing('new');
    setDraft(EMPTY_CHANNEL);
    setDirty(false);
    setNotice(null);
    onDirtyChange(false);
  }

  function openEdit(channel: NotificationChannelDto): void {
    setEditing(channel);
    // webhookUrl 只写不回填：掩码值绝不放进编辑器输入
    setDraft({ name: channel.name, webhookUrl: '', isEnabled: channel.isEnabled });
    setDirty(false);
    setNotice(null);
    onDirtyChange(false);
  }

  function updateDraft<K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    onDirtyChange(true);
  }

  function closeEditor(): void {
    if (!dirty || window.confirm('当前修改尚未保存，确定关闭吗？')) {
      setEditing(null);
      setDirty(false);
      onDirtyChange(false);
    }
  }

  async function saveChannel(): Promise<void> {
    if (!draft.name.trim()) {
      setError('请输入渠道名称。');
      return;
    }
    if (editing === 'new' && !draft.webhookUrl.trim()) {
      setError('请输入企业微信 Webhook URL。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing === 'new') {
        const payload: CreateNotificationChannelBody = {
          name: draft.name.trim(),
          webhookUrl: draft.webhookUrl.trim(),
          isEnabled: draft.isEnabled,
          actorId,
        };
        const created = await createChannel(payload);
        setChannels((current) => [created, ...current]);
        setTotal((current) => current + 1);
        setNotice('渠道已新增');
      } else if (editing) {
        const payload: UpdateNotificationChannelBody = {
          name: draft.name.trim(),
          isEnabled: draft.isEnabled,
          actorId,
        };
        // 编辑时仅当用户填了新值才随 PUT 提交 webhookUrl，留空则后端保留原密文
        if (draft.webhookUrl.trim()) payload.webhookUrl = draft.webhookUrl.trim();
        const updated = await updateChannel(editing.id, payload);
        setChannels((current) =>
          current.map((item) => (item.id === editing.id ? updated : item)),
        );
        setNotice('渠道已保存');
      }
      setEditing(null);
      setDirty(false);
      onDirtyChange(false);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleChannel(channel: NotificationChannelDto): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      // 通知 DTO 无乐观锁（无 version 字段），全量 PUT 需带 isEnabled
      const updated = await updateChannel(channel.id, {
        isEnabled: !channel.isEnabled,
        actorId,
      });
      setChannels((current) => current.map((item) => (item.id === channel.id ? updated : item)));
      setNotice(updated.isEnabled ? '渠道已启用' : '渠道已停用');
    } catch (requestError) {
      setError(friendlyError(requestError));
    }
  }

  return (
    <>
      <form
        className="notification-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setAppliedFilters(filters);
        }}
      >
        <label>
          状态
          <select
            value={filters.enabled}
            onChange={(event) =>
              setFilters({ ...filters, enabled: event.target.value as ChannelFilters['enabled'] })
            }
          >
            <option value="">全部状态</option>
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </label>
        <div className="notification-filters__actions">
          <button className="button button--primary" type="submit">
            查询
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setPage(1);
              setAppliedFilters(EMPTY_FILTERS);
            }}
          >
            重置
          </button>
        </div>
      </form>

      <div className="notification-toolbar">
        <p>
          共 <strong>{total}</strong> 条渠道
        </p>
        {canManageNotifications && (
          <div>
            <button className="button button--primary" type="button" onClick={openCreate}>
              新增渠道
            </button>
          </div>
        )}
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
            <div className="rules-state">正在加载渠道…</div>
          ) : error && channels.length === 0 ? (
            <div className="rules-state">
              <p>渠道加载失败</p>
              <button className="button" type="button" onClick={() => void load()}>
                重新加载
              </button>
            </div>
          ) : channels.length === 0 ? (
            <div className="rules-state">
              <p>没有符合条件的渠道</p>
              <span>调整筛选条件，或新增第一条渠道。</span>
            </div>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel.id}>
                    <td>
                      <strong>{channel.name}</strong>
                      <small>{channel.webhookUrlMasked}</small>
                    </td>
                    <td>
                      <span className={channel.isEnabled ? 'status status--on' : 'status'}>
                        {channel.isEnabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td>{formatTimestamp(channel.createdAt)}</td>
                    <td>{formatTimestamp(channel.updatedAt)}</td>
                    <td>
                      {canManageNotifications ? (
                        <div className="table-actions">
                          <button type="button" onClick={() => openEdit(channel)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            aria-label={`${channel.isEnabled ? '停用' : '启用'}“${channel.name}”`}
                            onClick={() => void toggleChannel(channel)}
                          >
                            {channel.isEnabled ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenTestSend({ channelId: channel.id })}
                          >
                            发送测试
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
          {!loading && total > 0 && (
            <nav className="rules-pagination" aria-label="渠道分页">
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

        {editing && (
          <aside
            className="rule-editor"
            aria-label={editing === 'new' ? '新增渠道表单' : '编辑渠道表单'}
          >
            <div className="panel-heading">
              <div>
                <p>{editing === 'new' ? 'NEW CHANNEL' : 'EDIT CHANNEL'}</p>
                <h3>{editing === 'new' ? '新增渠道' : '编辑渠道'}</h3>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭渠道表单"
                onClick={closeEditor}
              >
                ×
              </button>
            </div>
            <label>
              渠道名称
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => updateDraft('name', event.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              企业微信 Webhook URL
              <input
                value={draft.webhookUrl}
                onChange={(event) => updateDraft('webhookUrl', event.target.value)}
                placeholder={
                  editing === 'new'
                    ? 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
                    : '留空则不修改'
                }
                maxLength={2000}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={draft.isEnabled}
                onChange={(event) => updateDraft('isEnabled', event.target.checked)}
              />
              <span>保存后立即启用</span>
            </label>
            <div className="panel-actions">
              <button className="button" type="button" onClick={closeEditor}>
                取消
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={saving}
                onClick={() => void saveChannel()}
              >
                {saving ? '保存中…' : '保存渠道'}
              </button>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
