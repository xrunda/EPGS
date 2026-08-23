import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateNotificationTemplateBody,
  NotificationMsgTypeDto,
  NotificationTemplateDto,
  NotificationVariableDto,
  UpdateNotificationTemplateBody,
} from '@epgs/shared-types';
import {
  createTemplate,
  formatTimestamp,
  friendlyError,
  getNotificationVariables,
  listTemplates,
  updateTemplate,
} from './notificationApi';

interface TemplatePanelProps {
  actorId: string;
  /** 后端 @RequireRoles(SYSTEM_ADMIN) 强校验；此处仅隐藏写入口（UX 优化）。 */
  canManageNotifications: boolean;
  /** 编辑器 dirty 状态上抛给父弹窗，门控切 tab 与关闭。 */
  onDirtyChange(dirty: boolean): void;
  onOpenTestSend(preselected: { templateId: string }): void;
}

interface TemplateFilters {
  msgType: '' | NotificationMsgTypeDto;
  enabled: '' | 'true' | 'false';
}

interface TemplateDraft {
  name: string;
  msgType: NotificationMsgTypeDto;
  title: string;
  content: string;
  coverImageUrl: string;
  linkUrl: string;
  isEnabled: boolean;
}

const EMPTY_FILTERS: TemplateFilters = { msgType: '', enabled: '' };
const EMPTY_TEMPLATE: TemplateDraft = {
  name: '',
  msgType: 'TEXT',
  title: '',
  content: '',
  coverImageUrl: '',
  linkUrl: '',
  isEnabled: true,
};
const PAGE_SIZE = 20;

export function TemplatePanel({
  actorId,
  canManageNotifications,
  onDirtyChange,
  onOpenTestSend,
}: TemplatePanelProps): JSX.Element {
  const [templates, setTemplates] = useState<NotificationTemplateDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<TemplateFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<TemplateFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<NotificationTemplateDto | 'new' | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 插入变量字典（验收点 #2：选项只来自 GET /api/notification-templates/variables，绝不硬编码）
  const [variables, setVariables] = useState<NotificationVariableDto[]>([]);
  const [variablesError, setVariablesError] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const query = useMemo(
    () => ({
      msgType: appliedFilters.msgType || undefined,
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
      const response = await listTemplates(query);
      setTemplates(response.items);
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
    getNotificationVariables()
      .then((items) => {
        if (active) {
          setVariables(items);
          setVariablesError(false);
        }
      })
      .catch(() => {
        if (active) setVariablesError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  function openCreate(): void {
    setEditing('new');
    setDraft(EMPTY_TEMPLATE);
    setDirty(false);
    setNotice(null);
    onDirtyChange(false);
  }

  function openEdit(template: NotificationTemplateDto): void {
    setEditing(template);
    setDraft({
      name: template.name,
      msgType: template.msgType,
      title: template.titleTemplate ?? '',
      content: template.contentTemplate,
      coverImageUrl: template.coverImageUrl ?? '',
      linkUrl: template.linkUrl ?? '',
      isEnabled: template.isEnabled,
    });
    setDirty(false);
    setNotice(null);
    onDirtyChange(false);
  }

  function updateDraft<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void {
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

  /** 在正文 textarea 光标处插入 {{key}}；失焦仍保留选区（浏览器行为）。 */
  function insertVariable(key: string): void {
    if (!key) return;
    const textarea = contentRef.current;
    const start = textarea?.selectionStart ?? draft.content.length;
    const end = textarea?.selectionEnd ?? draft.content.length;
    const token = `{{${key}}}`;
    const next = draft.content.slice(0, start) + token + draft.content.slice(end);
    updateDraft('content', next);
    const cursor = start + token.length;
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  }

  async function saveTemplate(): Promise<void> {
    if (!draft.name.trim()) {
      setError('请输入模板名称。');
      return;
    }
    if (!draft.content.trim()) {
      setError('请输入消息正文模板。');
      return;
    }
    if (draft.msgType === 'NEWS' && !draft.title.trim()) {
      setError('NEWS 类型模板必须填写标题。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const base = {
        name: draft.name.trim(),
        msgType: draft.msgType,
        isEnabled: draft.isEnabled,
        actorId,
      };
      // 只为 NEWS 携带 title/cover/link；TEXT 绝不发这些键（forbidNonWhitelisted 仍允许缺省，
      // 但避免无意义键）；空白 URL → null 显式清空
      const newsFields = {
        titleTemplate: draft.title.trim(),
        coverImageUrl: draft.coverImageUrl.trim() || null,
        linkUrl: draft.linkUrl.trim() || null,
      };
      if (editing === 'new') {
        const payload: CreateNotificationTemplateBody = {
          ...base,
          contentTemplate: draft.content,
          ...(draft.msgType === 'NEWS' ? newsFields : {}),
        };
        const created = await createTemplate(payload);
        setTemplates((current) => [created, ...current]);
        setTotal((current) => current + 1);
        setNotice('模板已新增');
      } else if (editing) {
        const payload: UpdateNotificationTemplateBody = {
          ...base,
          contentTemplate: draft.content,
          ...(draft.msgType === 'NEWS' ? newsFields : {}),
        };
        const updated = await updateTemplate(editing.id, payload);
        setTemplates((current) =>
          current.map((item) => (item.id === editing.id ? updated : item)),
        );
        setNotice('模板已保存');
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

  async function toggleTemplate(template: NotificationTemplateDto): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      // 通知 DTO 无乐观锁（无 version 字段）
      const updated = await updateTemplate(template.id, {
        isEnabled: !template.isEnabled,
        actorId,
      });
      setTemplates((current) => current.map((item) => (item.id === template.id ? updated : item)));
      setNotice(updated.isEnabled ? '模板已启用' : '模板已停用');
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
          消息类型
          <select
            value={filters.msgType}
            onChange={(event) =>
              setFilters({
                ...filters,
                msgType: event.target.value as TemplateFilters['msgType'],
              })
            }
          >
            <option value="">全部类型</option>
            <option value="TEXT">文本</option>
            <option value="NEWS">图文</option>
          </select>
        </label>
        <label>
          状态
          <select
            value={filters.enabled}
            onChange={(event) =>
              setFilters({ ...filters, enabled: event.target.value as TemplateFilters['enabled'] })
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
          共 <strong>{total}</strong> 条模板
        </p>
        {canManageNotifications && (
          <div>
            <button className="button button--primary" type="button" onClick={openCreate}>
              新增模板
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
            <div className="rules-state">正在加载模板…</div>
          ) : error && templates.length === 0 ? (
            <div className="rules-state">
              <p>模板加载失败</p>
              <button className="button" type="button" onClick={() => void load()}>
                重新加载
              </button>
            </div>
          ) : templates.length === 0 ? (
            <div className="rules-state">
              <p>没有符合条件的模板</p>
              <span>调整筛选条件，或新增第一条模板。</span>
            </div>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{item.msgType === 'NEWS' ? '图文（NEWS）' : '文本（TEXT）'}</td>
                    <td>
                      <span className={item.isEnabled ? 'status status--on' : 'status'}>
                        {item.isEnabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td>{formatTimestamp(item.createdAt)}</td>
                    <td>{formatTimestamp(item.updatedAt)}</td>
                    <td>
                      {canManageNotifications ? (
                        <div className="table-actions">
                          <button type="button" onClick={() => openEdit(item)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            aria-label={`${item.isEnabled ? '停用' : '启用'}“${item.name}”`}
                            onClick={() => void toggleTemplate(item)}
                          >
                            {item.isEnabled ? '停用' : '启用'}
                          </button>
                          <button type="button" onClick={() => onOpenTestSend({ templateId: item.id })}>
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
            <nav className="rules-pagination" aria-label="模板分页">
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
            aria-label={editing === 'new' ? '新增模板表单' : '编辑模板表单'}
          >
            <div className="panel-heading">
              <div>
                <p>{editing === 'new' ? 'NEW TEMPLATE' : 'EDIT TEMPLATE'}</p>
                <h3>{editing === 'new' ? '新增模板' : '编辑模板'}</h3>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭模板表单"
                onClick={closeEditor}
              >
                ×
              </button>
            </div>
            <label>
              模板名称
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => updateDraft('name', event.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              消息类型
              <select
                value={draft.msgType}
                onChange={(event) =>
                  updateDraft('msgType', event.target.value as NotificationMsgTypeDto)
                }
              >
                <option value="TEXT">文本（TEXT）</option>
                <option value="NEWS">图文（NEWS）</option>
              </select>
            </label>
            {draft.msgType === 'NEWS' && (
              <>
                <label>
                  消息标题
                  <input
                    value={draft.title}
                    onChange={(event) => updateDraft('title', event.target.value)}
                    maxLength={200}
                    placeholder="NEWS 类型必填"
                  />
                </label>
                <label>
                  封面图 URL（选填）
                  <input
                    value={draft.coverImageUrl}
                    onChange={(event) => updateDraft('coverImageUrl', event.target.value)}
                    placeholder="https://…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  跳转链接（选填）
                  <input
                    value={draft.linkUrl}
                    onChange={(event) => updateDraft('linkUrl', event.target.value)}
                    placeholder="https://…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </>
            )}
            <label>
              插入变量
              <select
                value=""
                onChange={(event) => insertVariable(event.target.value)}
                aria-label="插入变量"
              >
                <option value="">插入变量…</option>
                {variablesError ? (
                  <option value="" disabled>
                    变量加载失败；请刷新后重试
                  </option>
                ) : (
                  variables.map((variable) => (
                    <option key={variable.key} value={variable.key}>
                      {`${variable.label}（{{${variable.key}}}）`}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              消息正文模板
              <textarea
                ref={contentRef}
                value={draft.content}
                onChange={(event) => updateDraft('content', event.target.value)}
                rows={6}
                placeholder="支持 {{变量}} 占位符"
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
                onClick={() => void saveTemplate()}
              >
                {saving ? '保存中…' : '保存模板'}
              </button>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
