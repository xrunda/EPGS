import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImportValidateResult,
  MatchFieldDto,
  MatchModeDto,
  MonitorLevelDto,
  MonitorRuleDto,
} from '@epgs/shared-types';
import { SEMANTIC_INTENT_MAX_LENGTH } from '@epgs/shared-types';
import {
  confirmRulesImport,
  createRule,
  listRules,
  RulesApiError,
  updateRule,
  validateRulesImport,
} from './rulesApi';
import './RulesModal.css';

interface RulesModalProps {
  open: boolean;
  onClose: () => void;
  canManageRules?: boolean;
  actorId?: string;
}

interface Filters {
  keyword: string;
  level: '' | MonitorLevelDto;
  enabled: '' | 'true' | 'false';
}

interface RuleDraft {
  keyword: string;
  level: MonitorLevelDto;
  matchField: MatchFieldDto;
  matchMode: MatchModeDto;
  category: string;
  notes: string;
  /** Issue #87: 这个关键词想关注什么情况（医生自己的话，可为空）。 */
  semanticIntent: string;
  isEnabled: boolean;
}

const EMPTY_FILTERS: Filters = { keyword: '', level: '', enabled: '' };
const EMPTY_RULE: RuleDraft = {
  keyword: '',
  level: 'RED',
  matchField: 'REPORT_TEXT',
  matchMode: 'CONTAINS',
  category: '',
  notes: '',
  semanticIntent: '',
  isEnabled: true,
};

const LEVEL_LABELS: Record<MonitorLevelDto, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  UNCLASSIFIED: '未分级',
};

const FIELD_LABELS: Record<MatchFieldDto, string> = {
  FINDINGS: '检查所见',
  IMPRESSION: '诊断意见',
  REPORT_TEXT: '报告内容与诊断',
  STUDY_DESCRIPTION: '检查项目',
  OTHER: '其他',
};

const MODE_LABELS: Record<MatchModeDto, string> = {
  CONTAINS: '包含',
  EXACT: '完全匹配',
  REGEX: '正则表达式',
};

function toDraft(rule: MonitorRuleDto): RuleDraft {
  return {
    keyword: rule.keyword,
    level: rule.level,
    matchField: rule.matchField,
    matchMode: rule.matchMode,
    category: rule.category ?? '',
    notes: rule.notes ?? '',
    semanticIntent: rule.semanticIntent ?? '',
    isEnabled: rule.isEnabled,
  };
}

function friendlyError(error: unknown): string {
  if (error instanceof RulesApiError) {
    if (error.code === 'RULE_CONFLICT') {
      return '存在重复或冲突规则，请调整关键词或匹配条件。';
    }
    if (error.code === 'RULE_VERSION_CONFLICT') {
      return '规则已被其他人修改，请刷新后重试。';
    }
    return error.message;
  }
  return '请求失败，请检查网络后重试。';
}

export function RulesModal({
  open,
  onClose,
  canManageRules = true,
  actorId = 'web-operator',
}: RulesModalProps): JSX.Element | null {
  const [rules, setRules] = useState<MonitorRuleDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<MonitorRuleDto | 'new' | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportValidateResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  const query = useMemo(
    () => ({
      keyword: appliedFilters.keyword.trim() || undefined,
      level: appliedFilters.level || undefined,
      isEnabled: appliedFilters.enabled === '' ? undefined : appliedFilters.enabled === 'true',
      page,
      pageSize: 20,
    }),
    [appliedFilters, page],
  );
  const pageCount = Math.max(1, Math.ceil(total / 20));

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
    if (open) void load();
  }, [open, load, reloadKey]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return;
    setEditing(null);
    setImportOpen(false);
    setDirty(false);
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open) return null;

  function openCreate(): void {
    setEditing('new');
    setDraft(EMPTY_RULE);
    setDirty(false);
    setNotice(null);
  }

  function openEdit(rule: MonitorRuleDto): void {
    setEditing(rule);
    setDraft(toDraft(rule));
    setDirty(false);
    setNotice(null);
  }

  function updateDraft<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function saveRule(): Promise<void> {
    if (!draft.keyword.trim()) {
      setError('请输入规则关键词。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        keyword: draft.keyword.trim(),
        level: draft.level,
        matchField: draft.matchField,
        matchMode: draft.matchMode,
        category: draft.category.trim() || null,
        notes: draft.notes.trim() || null,
        // Blank means "not configured" rather than an empty intent - the
        // server stores it as null, and such a rule is never sent to the AI.
        semanticIntent: draft.semanticIntent.trim() || null,
        isEnabled: draft.isEnabled,
        actorId,
      };
      if (editing === 'new') {
        const created = await createRule(payload);
        setRules((current) => [created, ...current]);
        setTotal((current) => current + 1);
        setNotice('规则已新增');
      } else if (editing) {
        const updated = await updateRule(editing.id, { ...payload, version: editing.version });
        setRules((current) => current.map((rule) => (rule.id === editing.id ? updated : rule)));
        setNotice('规则已保存');
      }
      setEditing(null);
      setDirty(false);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: MonitorRuleDto): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const updated = await updateRule(rule.id, {
        isEnabled: !rule.isEnabled,
        version: rule.version,
        actorId,
      });
      setRules((current) => current.map((item) => (item.id === rule.id ? updated : item)));
      setNotice(updated.isEnabled ? '规则已启用' : '规则已停用');
    } catch (requestError) {
      setError(friendlyError(requestError));
    }
  }

  async function validateImport(): Promise<void> {
    if (!importFile) {
      setError('请先选择 CSV 文件。');
      return;
    }
    setImportBusy(true);
    setError(null);
    try {
      setImportResult(await validateRulesImport(importFile));
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setImportBusy(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!importResult) return;
    setImportBusy(true);
    setError(null);
    try {
      const result = await confirmRulesImport(importResult.importToken, actorId);
      setNotice(`已成功导入 ${result.createdCount} 条规则`);
      setImportOpen(false);
      setImportFile(null);
      setImportResult(null);
      setReloadKey((current) => current + 1);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setImportBusy(false);
    }
  }

  function downloadTemplate(): void {
    const csv =
      'keyword,level,matchField,matchMode,category,notes\n癌,RED,REPORT_TEXT,CONTAINS,,示例规则\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '监测规则导入模板.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="rules-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-modal-title"
        tabIndex={-1}
      >
        <header className="rules-modal__header">
          <div>
            <p className="rules-modal__eyebrow">内镜中心 · 关键词与关注等级</p>
            <h2 id="rules-modal-title">关键词监控</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭关键词监控"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        <p className="rules-modal__lead">捕捉报告里写了什么「字」。</p>
        <p className="rules-modal__sublead">
          配置需要关注的疾病名称或关键词，系统会在报告里查找这些字，并把命中的患者按关注等级列到工作台。
        </p>
        <p className="rules-modal__crosssell">关键词监控看「字」 · AI 语义监控看「意思」</p>

        <div className="rules-modal__notice">
          <span aria-hidden="true">i</span>
          <p>规则修改仅影响后续新数据，不自动重算历史数据。</p>
        </div>

        <form
          className="rules-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAppliedFilters(filters);
          }}
        >
          <label>
            关键词
            <input
              value={filters.keyword}
              onChange={(event) => setFilters({ ...filters, keyword: event.target.value })}
              placeholder="搜索关键词"
            />
          </label>
          <label>
            关注等级
            <select
              value={filters.level}
              onChange={(event) =>
                setFilters({ ...filters, level: event.target.value as Filters['level'] })
              }
            >
              <option value="">全部等级</option>
              <option value="RED">红色</option>
              <option value="YELLOW">黄色</option>
              <option value="GREEN">绿色</option>
              <option value="UNCLASSIFIED">未分级</option>
            </select>
          </label>
          <label>
            状态
            <select
              value={filters.enabled}
              onChange={(event) =>
                setFilters({ ...filters, enabled: event.target.value as Filters['enabled'] })
              }
            >
              <option value="">全部状态</option>
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </label>
          <div className="rules-filters__actions">
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

        <div className="rules-toolbar">
          <p>
            共 <strong>{total}</strong> 条规则
          </p>
          <div>
            <button
              className="button"
              type="button"
              disabled
              title="操作日志将在权限与审计功能中接入"
            >
              操作日志
            </button>
            {canManageRules && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  setImportOpen(true);
                  setEditing(null);
                  setDirty(false);
                }}
              >
                批量导入
              </button>
            )}
            {canManageRules && (
              <button className="button button--primary" type="button" onClick={openCreate}>
                新增规则
              </button>
            )}
          </div>
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
              <div className="rules-state">正在加载监测规则…</div>
            ) : error && rules.length === 0 ? (
              <div className="rules-state">
                <p>规则加载失败</p>
                <button className="button" type="button" onClick={() => void load()}>
                  重新加载
                </button>
              </div>
            ) : rules.length === 0 ? (
              <div className="rules-state">
                <p>没有符合条件的监测规则</p>
                <span>调整筛选条件，或新增第一条规则。</span>
              </div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>关键词</th>
                    <th>关注等级</th>
                    <th>关注情况</th>
                    <th>匹配范围</th>
                    <th>匹配方式</th>
                    <th>状态</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <strong>{rule.keyword}</strong>
                        {rule.category && <small>{rule.category}</small>}
                      </td>
                      <td>
                        <span className={`level-tag level-tag--${rule.level.toLowerCase()}`}>
                          {LEVEL_LABELS[rule.level]}
                        </span>
                      </td>
                      <td className="rules-table__intent">
                        {rule.semanticIntent ? (
                          <span title={rule.semanticIntent}>{rule.semanticIntent}</span>
                        ) : (
                          // Not having one is a visible, actionable state rather
                          // than a blank: it is exactly the set of rules that
                          // are not being checked against their context.
                          <span className="rules-table__intent--none">未设置</span>
                        )}
                      </td>
                      <td>{FIELD_LABELS[rule.matchField]}</td>
                      <td>{MODE_LABELS[rule.matchMode]}</td>
                      <td>
                        <span className={rule.isEnabled ? 'status status--on' : 'status'}>
                          {rule.isEnabled ? '启用' : '停用'}
                        </span>
                      </td>
                      <td className="rules-table__notes">{rule.notes || '—'}</td>
                      <td>
                        {canManageRules ? (
                          <div className="table-actions">
                            <button type="button" onClick={() => openEdit(rule)}>
                              编辑
                            </button>
                            <button
                              type="button"
                              aria-label={`${rule.isEnabled ? '停用' : '启用'}“${rule.keyword}”`}
                              onClick={() => void toggleRule(rule)}
                            >
                              {rule.isEnabled ? '停用' : '启用'}
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
                  <p>{editing === 'new' ? 'NEW RULE' : `VERSION ${editing.version}`}</p>
                  <h3>{editing === 'new' ? '新增规则' : '编辑规则'}</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭规则表单"
                  onClick={() => {
                    if (!dirty || window.confirm('当前修改尚未保存，确定关闭吗？')) {
                      setEditing(null);
                      setDirty(false);
                    }
                  }}
                >
                  ×
                </button>
              </div>
              <label>
                规则关键词
                <input
                  autoFocus
                  value={draft.keyword}
                  onChange={(event) => updateDraft('keyword', event.target.value)}
                  placeholder="请输入疾病名称或关键词，例如：溃疡、肿物、癌……"
                  maxLength={255}
                />
              </label>
              <div className="form-grid">
                <label>
                  规则关注等级
                  <select
                    value={draft.level}
                    onChange={(event) =>
                      updateDraft('level', event.target.value as MonitorLevelDto)
                    }
                  >
                    <option value="RED">红色</option>
                    <option value="YELLOW">黄色</option>
                    <option value="GREEN">绿色</option>
                    <option value="UNCLASSIFIED">未分级</option>
                  </select>
                </label>
                <label>
                  匹配方式
                  <select
                    value={draft.matchMode}
                    onChange={(event) =>
                      updateDraft('matchMode', event.target.value as MatchModeDto)
                    }
                  >
                    <option value="CONTAINS">包含</option>
                    <option value="EXACT">完全匹配</option>
                    <option value="REGEX">正则表达式</option>
                  </select>
                </label>
              </div>
              <label>
                匹配范围
                <select
                  value={draft.matchField}
                  onChange={(event) =>
                    updateDraft('matchField', event.target.value as MatchFieldDto)
                  }
                >
                  <option value="REPORT_TEXT">报告内容与诊断</option>
                  <option value="FINDINGS">检查所见</option>
                  <option value="IMPRESSION">诊断意见</option>
                  <option value="STUDY_DESCRIPTION">检查项目</option>
                  <option value="OTHER">其他</option>
                </select>
              </label>
              <label>
                这个关键词想关注什么情况（选填）
                <textarea
                  value={draft.semanticIntent}
                  onChange={(event) => updateDraft('semanticIntent', event.target.value)}
                  placeholder="例如：本次检查明确或疑似存在的病变；单独出现的否认句或既往史不算。"
                  rows={3}
                  maxLength={SEMANTIC_INTENT_MAX_LENGTH}
                />
              </label>
              <p className="panel-copy">
                用一句话说明这个关键词想抓的情况。填写后，系统会看报告里命中处的上下文，判断这句话是不是真的在说这个情况；留空则不判断，命中即计入关注。
              </p>
              <label>
                分类（选填）
                <input
                  value={draft.category}
                  onChange={(event) => updateDraft('category', event.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                备注
                <textarea
                  value={draft.notes}
                  onChange={(event) => updateDraft('notes', event.target.value)}
                  rows={4}
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
              <div className="panel-actions panel-actions--sticky">
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setDirty(false);
                  }}
                >
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

          {importOpen && (
            <aside className="rule-editor" aria-label="批量导入规则">
              <div className="panel-heading">
                <div>
                  <p>CSV IMPORT</p>
                  <h3>批量导入</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭批量导入"
                  onClick={() => setImportOpen(false)}
                >
                  ×
                </button>
              </div>
              <p className="panel-copy">上传 UTF-8 CSV 文件，系统先预校验，确认后才写入规则。</p>
              <button className="text-button" type="button" onClick={downloadTemplate}>
                下载 CSV 模板
              </button>
              <label className="file-field">
                选择 CSV 文件
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] ?? null);
                    setImportResult(null);
                  }}
                />
                <span>{importFile?.name ?? '未选择文件'}</span>
              </label>
              <button
                className="button button--primary"
                type="button"
                disabled={importBusy}
                onClick={() => void validateImport()}
              >
                {importBusy ? '校验中…' : '预校验'}
              </button>
              {importResult && (
                <div className="import-result">
                  <strong>
                    {importResult.validRows} 条可导入，{importResult.errors.length} 条错误
                  </strong>
                  {importResult.preview.length > 0 && (
                    <ul>
                      {importResult.preview.map((row) => (
                        <li key={row.line}>
                          第 {row.line} 行：{row.keyword}
                        </li>
                      ))}
                    </ul>
                  )}
                  {importResult.errors.length > 0 && (
                    <ul className="import-errors">
                      {importResult.errors.map((row) => (
                        <li key={`${row.line}-${row.message}`}>
                          第 {row.line} 行：{row.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={importBusy || importResult.validRows === 0}
                    onClick={() => void confirmImport()}
                  >
                    确认导入 {importResult.validRows} 条
                  </button>
                </div>
              )}
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
