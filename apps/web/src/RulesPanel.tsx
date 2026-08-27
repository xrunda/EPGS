import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateNotificationRuleBody,
  NotificationChannelDto,
  NotificationPushDeliveryStatusDto,
  NotificationPushStatusDto,
  NotificationRuleDto,
  NotificationTemplateDto,
  RunNotificationRuleResult,
  UpdateNotificationRuleBody,
} from '@epgs/shared-types';
import {
  createRule,
  formatTimestamp,
  friendlyError,
  listChannels,
  listRules,
  listTemplates,
  runRule,
  updateRule,
} from './notificationApi';

interface RulesPanelProps {
  actorId: string;
  /** 后端 @RequireRoles(SYSTEM_ADMIN) 强校验；此处仅隐藏写入口（UX 优化）。 */
  canManageNotifications: boolean;
  /** 编辑器 dirty 状态上抛给父弹窗，门控切 tab 与关闭。 */
  onDirtyChange(dirty: boolean): void;
}

interface RuleFilters {
  enabled: '' | 'true' | 'false';
}

interface RuleDraft {
  name: string;
  cron: string;
  templateId: string;
  channelIds: string[];
  isEnabled: boolean;
}

const EMPTY_FILTERS: RuleFilters = { enabled: '' };

/**
 * 常用推送时间预设（静态常量，不依赖接口；cron 为 5 段，Asia/Shanghai 求值）。
 *
 * 仅收录"每天/每周最多一次"的低频预设：SCHEDULED 推送的幂等去重键是
 * (rule_id, windowDate) 天粒度（见 rule-executor.ts + DB 部分唯一索引
 * uq_push_log_scheduled_dedup），一天只允许成功写入一条 push_log。曾经的
 * "每 30 分钟"预设与此冲突——当天第一次触发后，同一天内的所有后续触发都会
 * 被判定为"今日已推送"而跳过，实际效果是一天只真正推送一次（且是第一次
 * 命中的那次，而非用户预期的高频循环），因此移除，不再提供分钟级预设。
 */
const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: '每天 9:00', cron: '0 9 * * *' },
  { label: '每天 8:00', cron: '0 8 * * *' },
  { label: '每天 18:00', cron: '0 18 * * *' },
  { label: '每周一 9:00', cron: '0 9 * * 1' },
];

const EMPTY_RULE: RuleDraft = {
  name: '',
  cron: CRON_PRESETS[0].cron,
  templateId: '',
  channelIds: [],
  isEnabled: true,
};
const PAGE_SIZE = 20;

function pushStatusLabel(status: NotificationPushStatusDto | null): string {
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

function deliveryStatusLabel(status: NotificationPushDeliveryStatusDto): string {
  return status === 'SUCCESS' ? '成功' : '失败';
}

export function RulesPanel({
  actorId,
  canManageNotifications,
  onDirtyChange,
}: RulesPanelProps): JSX.Element {
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<RuleFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<RuleFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<NotificationRuleDto | 'new' | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 「立即执行一次」运行中的规则 id（禁用其行内按钮）
  const [runningId, setRunningId] = useState<string | null>(null);
  // 手动补推的逐渠道结果反馈
  const [runNotice, setRunNotice] = useState<{
    ruleName: string;
    result: RunNotificationRuleResult;
  } | null>(null);
  // 编辑器选项：启用态模板/渠道（并行拉一次）
  const [templates, setTemplates] = useState<NotificationTemplateDto[]>([]);
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);

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
      const response = await listRules(query);
      setRules(response.items);
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

  useEffect(() => {
    let active = true;
    Promise.all([
      listTemplates({ isEnabled: true, pageSize: 100 }),
      listChannels({ isEnabled: true, pageSize: 100 }),
    ])
      .then(([templatePage, channelPage]) => {
        if (!active) return;
        setTemplates(templatePage.items);
        setChannels(channelPage.items);
        setOptionsError(null);
      })
      .catch(() => {
        if (active) setOptionsError('模板/渠道选项加载失败，请刷新后重试。');
      });
    return () => {
      active = false;
    };
  }, []);

  function openCreate(): void {
    setEditing('new');
    setDraft(EMPTY_RULE);
    setDirty(false);
    setNotice(null);
    setRunNotice(null);
    onDirtyChange(false);
  }

  function openEdit(rule: NotificationRuleDto): void {
    // 把规则已绑定的渠道并入复选选项（含已停用者），避免编辑时静默丢失绑定
    setChannels((current) => {
      const byId = new Map(current.map((channel) => [channel.id, channel]));
      rule.channels.forEach((binding) => {
        if (!byId.has(binding.channelId)) {
          byId.set(binding.channelId, {
            id: binding.channelId,
            name: binding.name,
            webhookUrlMasked: '',
            isEnabled: false,
            createdAt: '',
            updatedAt: '',
            createdBy: '',
            updatedBy: '',
          });
        }
      });
      return [...byId.values()];
    });
    setEditing(rule);
    setDraft({
      name: rule.name,
      cron: rule.cron,
      templateId: rule.templateId,
      channelIds: rule.channels.map((binding) => binding.channelId),
      isEnabled: rule.isEnabled,
    });
    setDirty(false);
    setNotice(null);
    setRunNotice(null);
    onDirtyChange(false);
  }

  function updateDraft<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    onDirtyChange(true);
  }

  function toggleChannelId(id: string): void {
    updateDraft(
      'channelIds',
      draft.channelIds.includes(id)
        ? draft.channelIds.filter((channelId) => channelId !== id)
        : [...draft.channelIds, id],
    );
  }

  function closeEditor(): void {
    if (!dirty || window.confirm('当前修改尚未保存，确定关闭吗？')) {
      setEditing(null);
      setDirty(false);
      onDirtyChange(false);
    }
  }

  async function saveRule(): Promise<void> {
    if (!draft.name.trim()) {
      setError('请输入规则名称。');
      return;
    }
    if (!draft.cron.trim()) {
      setError('请输入推送时间（Cron 表达式）。');
      return;
    }
    if (!draft.templateId) {
      setError('请选择推送模板。');
      return;
    }
    if (draft.channelIds.length === 0) {
      setError('请至少选择一个推送渠道。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing === 'new') {
        const payload: CreateNotificationRuleBody = {
          name: draft.name.trim(),
          cron: draft.cron.trim(),
          templateId: draft.templateId,
          channelIds: draft.channelIds,
          isEnabled: draft.isEnabled,
          actorId,
        };
        const created = await createRule(payload);
        setRules((current) => [created, ...current]);
        setTotal((current) => current + 1);
        setNotice('规则已新增');
      } else if (editing) {
        const payload: UpdateNotificationRuleBody = {
          name: draft.name.trim(),
          cron: draft.cron.trim(),
          templateId: draft.templateId,
          channelIds: draft.channelIds,
          isEnabled: draft.isEnabled,
          actorId,
        };
        const updated = await updateRule(editing.id, payload);
        setRules((current) => current.map((item) => (item.id === editing.id ? updated : item)));
        setNotice('规则已保存');
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

  async function toggleRule(rule: NotificationRuleDto): Promise<void> {
    setError(null);
    setNotice(null);
    setRunNotice(null);
    try {
      // 通知 DTO 无乐观锁（无 version 字段）
      const updated = await updateRule(rule.id, { isEnabled: !rule.isEnabled, actorId });
      setRules((current) => current.map((item) => (item.id === rule.id ? updated : item)));
      setNotice(updated.isEnabled ? '规则已启用' : '规则已停用');
    } catch (requestError) {
      setError(friendlyError(requestError));
    }
  }

  /** 「立即执行一次」：同一执行路径（trigger=MANUAL），永远允许，逐渠道独立记录。 */
  async function runRuleNow(rule: NotificationRuleDto): Promise<void> {
    if (
      !window.confirm(
        `立即执行一次“${rule.name}”？将按今日（上海时区）新报告口径向 ${rule.channels.length} 个渠道真实推送。`,
      )
    )
      return;
    setError(null);
    setNotice(null);
    setRunningId(rule.id);
    try {
      const result = await runRule(rule.id);
      setRunNotice({ ruleName: rule.name, result });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setRunningId(null);
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
              setFilters({ ...filters, enabled: event.target.value as RuleFilters['enabled'] })
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
          共 <strong>{total}</strong> 条规则
        </p>
        {canManageNotifications && (
          <div>
            <button className="button button--primary" type="button" onClick={openCreate}>
              新增规则
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
      {runNotice && (
        <div
          className={`feedback ${
            runNotice.result.status === 'SUCCESS'
              ? 'feedback--success'
              : runNotice.result.status === 'FAILED'
                ? 'feedback--error'
                : 'notification-feedback--warning'
          }`}
          role="status"
        >
          <div>
            <p>
              「{runNotice.ruleName}」已执行：{pushStatusLabel(runNotice.result.status)}（共
              {runNotice.result.deliveries.length} 个渠道）
            </p>
            {runNotice.result.deliveries.length > 0 && (
              <ul className="notification-run-deliveries">
                {runNotice.result.deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <span
                      className={`notification-status ${
                        delivery.status === 'SUCCESS'
                          ? 'notification-status--ok'
                          : 'notification-status--bad'
                      }`}
                    >
                      {deliveryStatusLabel(delivery.status)}
                    </span>
                    <span>{delivery.channelName}</span>
                    {delivery.wecomErrMsg && <small>{delivery.wecomErrMsg}</small>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={() => setRunNotice(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="rules-content">
        <div className="rules-table-wrap">
          {loading ? (
            <div className="rules-state">正在加载规则…</div>
          ) : error && rules.length === 0 ? (
            <div className="rules-state">
              <p>规则加载失败</p>
              <button className="button" type="button" onClick={() => void load()}>
                重新加载
              </button>
            </div>
          ) : rules.length === 0 ? (
            <div className="rules-state">
              <p>没有符合条件的规则</p>
              <span>调整筛选条件，或新增第一条推送规则。</span>
            </div>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>模板</th>
                  <th>渠道数</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <strong>{rule.name}</strong>
                    </td>
                    <td>{rule.templateName}</td>
                    <td>
                      {rule.channels.length}
                      <small>{rule.channels.map((binding) => binding.name).join('、')}</small>
                    </td>
                    <td>
                      <span className={rule.isEnabled ? 'status status--on' : 'status'}>
                        {rule.isEnabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td>{formatTimestamp(rule.updatedAt)}</td>
                    <td>
                      {canManageNotifications ? (
                        <div className="table-actions">
                          <button type="button" onClick={() => openEdit(rule)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            aria-label={`${rule.isEnabled ? '停用' : '启用'}“${rule.name}”`}
                            onClick={() => void toggleRule(rule)}
                          >
                            {rule.isEnabled ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            disabled={runningId === rule.id}
                            onClick={() => void runRuleNow(rule)}
                          >
                            {runningId === rule.id ? '执行中…' : '立即执行一次'}
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
            <nav className="rules-pagination" aria-label="规则分页">
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
            aria-label={editing === 'new' ? '新增规则表单' : '编辑规则表单'}
          >
            <div className="panel-heading">
              <div>
                <p>{editing === 'new' ? 'NEW RULE' : 'EDIT RULE'}</p>
                <h3>{editing === 'new' ? '新增规则' : '编辑规则'}</h3>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭规则表单"
                onClick={closeEditor}
              >
                ×
              </button>
            </div>
            <label>
              规则名称
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => updateDraft('name', event.target.value)}
                maxLength={100}
                placeholder="例如：每日 9 点推送到总值班室群"
              />
            </label>
            <div className="notification-cron-field">
              <span className="notification-cron-field__label">推送时间（Asia/Shanghai）</span>
              <div className="notification-cron-presets" role="group" aria-label="常用推送时间">
                {CRON_PRESETS.map((preset) => (
                  <button
                    key={preset.cron}
                    className={`button${draft.cron === preset.cron ? ' button--primary' : ''}`}
                    type="button"
                    onClick={() => updateDraft('cron', preset.cron)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <label>
              推送模板
              <select
                value={draft.templateId}
                onChange={(event) => updateDraft('templateId', event.target.value)}
              >
                <option value="">选择模板…</option>
                {optionsError ? (
                  <option value="" disabled>
                    模板/渠道选项加载失败，请刷新后重试
                  </option>
                ) : (
                  templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <fieldset className="notification-channel-picker">
              <legend>推送渠道（可多选）</legend>
              {optionsError ? (
                <p className="notification-option-error">{optionsError}</p>
              ) : channels.length === 0 ? (
                <p className="notification-option-error">暂无启用中的渠道，请先在「渠道」页新增并启用。</p>
              ) : (
                <div className="notification-channel-options">
                  {channels.map((channel) => (
                    <label key={channel.id} className="notification-channel-option">
                      <input
                        type="checkbox"
                        checked={draft.channelIds.includes(channel.id)}
                        onChange={() => toggleChannelId(channel.id)}
                      />
                      <span>{channel.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
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
                onClick={() => void saveRule()}
              >
                {saving ? '保存中…' : '保存规则'}
              </button>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
