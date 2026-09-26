import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttentionLevelDto, AttentionSemanticDto } from '@epgs/shared-types';
import {
  ATTENTION_LEVELS_DTO,
  ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH,
  ATTENTION_SEMANTIC_NAME_MAX_LENGTH,
} from '@epgs/shared-types';
// 等级文字只有一个来源（attentionSource.ts）：本页的池标题、表格行内标签、
// 新增/编辑表单的等级卡片、筛选下拉，以及工作台列表与详情抽屉共用同一个映射。
// 分开写多份字面量正是上一轮漏改三处的原因，所以这里只引用、不再声明。
import { ATTENTION_LEVEL_LABELS as POOL_LABELS } from './attentionSource';
import {
  AiSemanticsApiError,
  createAiSemantic,
  importDefaultAiSemantics,
  listAiSemantics,
  updateAiSemantic,
} from './aiSemanticsApi';
import './SemanticMonitorModal.css';

/**
 * AI 语义监控配置（issue #88）—— 管理「关注语义池」，即这家医院想让系统替他盯着
 * 的每一种情况，以及这种情况属于哪个关注等级。
 *
 * 术语是产品定稿的，不要改：这一页叫「AI 语义监控」，一条配置叫「关注语义」，
 * 等级叫「关注等级」。界面上一律不出现 Prompt / 提示词 / 大模型 / 分类器 这类
 * 实现词汇 —— 医生配的是「要关注什么情况」，不是「给模型写什么指令」。
 *
 * 三个必须出现在界面上的固定说法：
 *   - 关注等级是管理上的关注等级，不是诊断结论，也不代表病情严重程度；
 *   - 仅用于监测，不作为正式诊断；
 *   - 修改语义文字会生成新版本，历史判定仍指向修改前的文字。
 *
 * 与「关键词监控」的关系：那边管字，这边管意思。两边互不影响 —— 这一页无论
 * 怎么配，关键词命中的结果都不会变；这里新增的语义判断只会让关注等级上调。
 */

interface SemanticMonitorModalProps {
  open: boolean;
  onClose: () => void;
  /** RULE_ADMIN 才能改；只读用户看不到写操作（服务端同样会拦）。 */
  canManageAiSemantics?: boolean;
  actorId?: string;
}

interface Filters {
  name: string;
  level: '' | AttentionLevelDto;
  enabled: '' | 'true' | 'false';
}

interface SemanticDraft {
  name: string;
  description: string;
  attentionLevel: AttentionLevelDto;
  isEnabled: boolean;
}

const EMPTY_FILTERS: Filters = { name: '', level: '', enabled: '' };
const EMPTY_DRAFT: SemanticDraft = {
  name: '',
  description: '',
  attentionLevel: 'YELLOW',
  isEnabled: true,
};

/**
 * 每种颜色在业务上意味着什么。这是「关注等级」（要多久看到），不是病情严重程度，
 * 措辞必须与 docs/data-dictionary.md 一致。
 */
const LEVEL_HINTS: Record<AttentionLevelDto, string> = {
  RED: '需要尽快人工确认',
  YELLOW: '需要留意或安排跟进',
  GREEN: '值得记录，暂不需要处理',
};

const PAGE_SIZE = 20;

function toDraft(semantic: AttentionSemanticDto): SemanticDraft {
  return {
    name: semantic.name,
    description: semantic.description,
    attentionLevel: semantic.attentionLevel,
    isEnabled: semantic.isEnabled,
  };
}

function friendlyError(error: unknown): string {
  if (error instanceof AiSemanticsApiError) {
    if (error.code === 'ATTENTION_SEMANTIC_CONFLICT') {
      return '已有同名的启用语义，请改名称，或先停用原来那条。';
    }
    if (error.code === 'ATTENTION_SEMANTIC_VERSION_CONFLICT') {
      return '这条语义已被其他人修改，请刷新后重试。';
    }
    if (error.status === 403) {
      return '当前账号没有修改语义配置的权限。';
    }
    return error.message;
  }
  return '请求失败，请检查网络后重试。';
}

export function SemanticMonitorModal({
  open,
  onClose,
  canManageAiSemantics = true,
  actorId = 'web-operator',
}: SemanticMonitorModalProps): JSX.Element | null {
  const [items, setItems] = useState<AttentionSemanticDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  /** 当前生效的语义按颜色各有多少条；取不到就不显示，不影响列表。 */
  const [poolCounts, setPoolCounts] = useState<Record<AttentionLevelDto, number> | null>(null);
  const [editing, setEditing] = useState<AttentionSemanticDto | 'new' | null>(null);
  const [draft, setDraft] = useState<SemanticDraft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [overwriteOnLoad, setOverwriteOnLoad] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  const query = useMemo(
    () => ({
      name: appliedFilters.name.trim() || undefined,
      attentionLevel: appliedFilters.level || undefined,
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
      const response = await listAiSemantics(query);
      setItems(response.items);
      setTotal(response.total);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [query]);

  /**
   * 三色池概览：三条只取总数的查询。只统计「启用」的语义 —— 停用的语义不会再
   * 参与判读，把它们算进来会让人以为医院漏配了什么。失败就整块不显示。
   */
  const loadPoolCounts = useCallback(async () => {
    try {
      const counts = await Promise.all(
        ATTENTION_LEVELS_DTO.map(async (level) => {
          const response = await listAiSemantics({
            attentionLevel: level,
            isEnabled: true,
            page: 1,
            pageSize: 1,
          });
          return [level, response.total] as const;
        }),
      );
      setPoolCounts(Object.fromEntries(counts) as Record<AttentionLevelDto, number>);
    } catch {
      setPoolCounts(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    void loadPoolCounts();
  }, [open, load, loadPoolCounts, reloadKey]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return;
    setEditing(null);
    setPresetOpen(false);
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
    setPresetOpen(false);
    setDraft(EMPTY_DRAFT);
    setDirty(false);
    setNotice(null);
  }

  function openEdit(semantic: AttentionSemanticDto): void {
    setEditing(semantic);
    setPresetOpen(false);
    setDraft(toDraft(semantic));
    setDirty(false);
    setNotice(null);
  }

  function updateDraft<K extends keyof SemanticDraft>(key: K, value: SemanticDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  /** 写操作成功后统一重新拉取：改文字会换成一个新版本行，本地拼接容易漏掉旧行。 */
  function refreshAfterWrite(): void {
    setEditing(null);
    setDirty(false);
    setReloadKey((current) => current + 1);
  }

  async function saveSemantic(): Promise<void> {
    if (!draft.name.trim()) {
      setError('请填写这条关注语义的名称。');
      return;
    }
    if (!draft.description.trim()) {
      setError('请说明这条关注语义要关注报告里的什么情况。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        attentionLevel: draft.attentionLevel,
        isEnabled: draft.isEnabled,
        actorId,
      };
      if (editing === 'new') {
        await createAiSemantic(payload);
        setNotice('关注语义已新增');
      } else if (editing) {
        await updateAiSemantic(editing.id, { ...payload, version: editing.version });
        setNotice('关注语义已保存，历史判定仍指向修改前的文字');
      }
      refreshAfterWrite();
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleSemantic(semantic: AttentionSemanticDto): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await updateAiSemantic(semantic.id, {
        isEnabled: !semantic.isEnabled,
        version: semantic.version,
        actorId,
      });
      setNotice(semantic.isEnabled ? '已停用，系统不再按这条语义判读报告' : '已启用');
      setReloadKey((current) => current + 1);
    } catch (requestError) {
      setError(friendlyError(requestError));
    }
  }

  async function loadDefaults(): Promise<void> {
    setDefaultsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importDefaultAiSemantics(overwriteOnLoad, actorId);
      const parts = [`已载入 ${result.createdCount} 条预置语义`];
      if (result.skippedCount > 0) parts.push(`跳过 ${result.skippedCount} 条已存在的`);
      if (result.updatedCount > 0) parts.push(`覆盖 ${result.updatedCount} 条`);
      setNotice(`${parts.join('，')}。请逐条核对是否适合本院。`);
      setPresetOpen(false);
      setReloadKey((current) => current + 1);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setDefaultsBusy(false);
    }
  }

  const enabledCount = items.filter((item) => item.isEnabled).length;

  return (
    <div
      className="semantic-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="semantic-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="semantic-modal-title"
        tabIndex={-1}
      >
        <header className="semantic-modal__header">
          <div>
            <p className="semantic-modal__eyebrow">内镜中心 · 语义与关注等级</p>
            <h2 id="semantic-modal-title">AI 语义监控</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭 AI 语义监控"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        <p className="semantic-modal__lead">理解医生这句话真正表达了什么意思。</p>
        <p className="semantic-modal__sublead">
          用医生自己的话写下需要关注的情况。系统会读完整份报告，判断有没有表达这层意思 ——
          即使报告里一个字都没写到。
        </p>
        <p className="semantic-modal__crosssell">关键词监控看「字」 · AI 语义监控看「意思」</p>

        <div className="semantic-modal__notice">
          <span aria-hidden="true">i</span>
          <p>
            关注等级是管理上的<b>关注等级</b>
            （需要多快看到），不是诊断结论，也不代表病情严重程度。本页结果仅用于监测，
            <b>不作为正式诊断</b>；未经审核的报告仅供参考。
          </p>
        </div>

        <div className="semantic-pool" aria-label="三色关注池">
          {poolCounts && (
            <>
              <p className="semantic-pool__title">
                当前生效
                <strong>
                  {ATTENTION_LEVELS_DTO.reduce((sum, level) => sum + poolCounts[level], 0)} 条
                </strong>
              </p>
              <ul className="semantic-pool__chips">
                {ATTENTION_LEVELS_DTO.map((level) => (
                  <li key={level}>
                    <span className={`level-tag level-tag--${level.toLowerCase()}`}>
                      {POOL_LABELS[level]}
                    </span>
                    <strong>{poolCounts[level]}</strong>
                    <span className="semantic-pool__hint">{LEVEL_HINTS[level]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="semantic-pool__footer">
            语义判断只会把关注等级往上调，不会把关键词已经命中的等级降下来。两边都命中时取较高的那一个。
          </p>
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
            名称
            <input
              value={filters.name}
              onChange={(event) => setFilters({ ...filters, name: event.target.value })}
              placeholder="搜索关注语义名称"
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
              {ATTENTION_LEVELS_DTO.map((level) => (
                <option key={level} value={level}>
                  {POOL_LABELS[level]}
                </option>
              ))}
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
            共 <strong>{total}</strong> 条关注语义（含停用与历史版本）
            {items.length > 0 && total > 0 ? `，本页启用 ${enabledCount} 条` : ''}
          </p>
          <div>
            {canManageAiSemantics && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  setPresetOpen(true);
                  setEditing(null);
                  setDirty(false);
                }}
              >
                载入预置语义
              </button>
            )}
            {canManageAiSemantics && (
              <button className="button button--primary" type="button" onClick={openCreate}>
                新增关注语义
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
              <div className="rules-state">正在加载关注语义…</div>
            ) : error && items.length === 0 ? (
              <div className="rules-state">
                <p>关注语义加载失败</p>
                <button className="button" type="button" onClick={() => void load()}>
                  重新加载
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="rules-state">
                <p>还没有配置任何关注语义</p>
                <span>
                  可以点「载入预置语义」拿一份通用模板开始，再逐条改成适合本院的说法。
                  没有配置时，系统只做关键词监测，行为与以前完全一致。
                </span>
              </div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>关注语义</th>
                    <th>关注等级</th>
                    <th>说明</th>
                    <th>版本</th>
                    <th>状态</th>
                    <th>最后修改</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((semantic) => (
                    <tr key={semantic.id}>
                      <td>
                        <strong>{semantic.name}</strong>
                      </td>
                      <td>
                        <span
                          className={`level-tag level-tag--${semantic.attentionLevel.toLowerCase()}`}
                        >
                          {POOL_LABELS[semantic.attentionLevel]}
                        </span>
                      </td>
                      <td className="semantic-table__description">
                        <span title={semantic.description}>{semantic.description}</span>
                      </td>
                      <td>
                        <span className="semantic-table__version">v{semantic.version}</span>
                      </td>
                      <td>
                        <span className={semantic.isEnabled ? 'status status--on' : 'status'}>
                          {semantic.isEnabled ? '启用' : '停用'}
                        </span>
                      </td>
                      <td className="semantic-table__meta">
                        {semantic.updatedBy}
                        <small>{semantic.updatedAt.slice(0, 10)}</small>
                      </td>
                      <td>
                        {canManageAiSemantics ? (
                          <div className="table-actions">
                            <button type="button" onClick={() => openEdit(semantic)}>
                              编辑
                            </button>
                            <button
                              type="button"
                              aria-label={`${semantic.isEnabled ? '停用' : '启用'}“${semantic.name}”`}
                              onClick={() => void toggleSemantic(semantic)}
                            >
                              {semantic.isEnabled ? '停用' : '启用'}
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
              <nav className="rules-pagination" aria-label="关注语义分页">
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
              aria-label={editing === 'new' ? '新增关注语义表单' : '编辑关注语义表单'}
            >
              <div className="panel-heading">
                <div>
                  <p>{editing === 'new' ? 'NEW SEMANTIC' : `VERSION ${editing.version}`}</p>
                  <h3>{editing === 'new' ? '新增关注语义' : '编辑关注语义'}</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭关注语义表单"
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
                关注语义名称
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(event) => updateDraft('name', event.target.value)}
                  placeholder="例如：明确或高度疑似恶性病变"
                  maxLength={ATTENTION_SEMANTIC_NAME_MAX_LENGTH}
                />
              </label>
              <p className="panel-copy">给医生看的短名称，同一条语义的名称不能与已启用的重名。</p>

              <fieldset className="semantic-level-picker">
                <legend>关注等级</legend>
                {ATTENTION_LEVELS_DTO.map((level) => (
                  <label key={level} className="semantic-level-picker__option">
                    <input
                      type="radio"
                      name="attentionLevel"
                      value={level}
                      checked={draft.attentionLevel === level}
                      onChange={() => updateDraft('attentionLevel', level)}
                    />
                    <span className={`level-tag level-tag--${level.toLowerCase()}`}>
                      {POOL_LABELS[level]}
                    </span>
                    <span className="semantic-level-picker__hint">{LEVEL_HINTS[level]}</span>
                  </label>
                ))}
              </fieldset>

              <label>
                这类情况是什么样的（说明）
                <textarea
                  value={draft.description}
                  onChange={(event) => updateDraft('description', event.target.value)}
                  placeholder="例如：报告描述了提示恶性或高度可疑恶性的表现，例如不规则隆起、边缘呈堤状、质脆易出血……"
                  rows={5}
                  maxLength={ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH}
                />
              </label>
              <p className="panel-copy">
                系统判断时读的就是这段话。请描述报告里会出现什么表现、什么含义，而不是只给一个结论
                —— 只写结论会让判断失去依据。
              </p>

              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={draft.isEnabled}
                  onChange={(event) => updateDraft('isEnabled', event.target.checked)}
                />
                <span>保存后立即启用</span>
              </label>

              <p className="panel-copy">
                修改名称、说明或关注等级会生成一个新版本，原版本自动停用；历史判定仍然指向当时使用的那一版文字，不会被改写。
              </p>

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
                  onClick={() => void saveSemantic()}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </aside>
          )}

          {!editing && presetOpen && (
            <aside className="rule-editor" aria-label="载入预置语义">
              <div className="panel-heading">
                <div>
                  <p>PRESET</p>
                  <h3>载入预置语义</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭载入预置语义"
                  onClick={() => setPresetOpen(false)}
                >
                  ×
                </button>
              </div>
              <p className="panel-copy">
                预置语义是一份通用模板，不是任何学会或医院的标准，也没有经过临床验证。
                载入只是把它们复制成本院的配置，之后可以随意修改。
              </p>
              <p className="panel-copy">
                只有点了这个按钮才会载入 —— 系统升级不会自动写入任何医学配置。
              </p>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={overwriteOnLoad}
                  onChange={(event) => setOverwriteOnLoad(event.target.checked)}
                />
                <span>用模板覆盖同名语义（会生成新版本）</span>
              </label>
              <p className="panel-copy">
                不勾选时，同名语义保持本院现有的名称、说明和关注等级不变。
              </p>
              <div className="panel-actions panel-actions--sticky">
                <button className="button" type="button" onClick={() => setPresetOpen(false)}>
                  取消
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={defaultsBusy}
                  onClick={() => void loadDefaults()}
                >
                  {defaultsBusy ? '载入中…' : '确认载入'}
                </button>
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
