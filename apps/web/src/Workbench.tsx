import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MonitorExamWorkbenchDto,
  MonitorLevelDto,
  MonitorSummaryDto,
  SyncHealthState,
  SyncStatusDto,
} from '@epgs/shared-types';
import { getExamSummary, listExams, MonitorApiError, getSyncStatus } from './monitorApi';
import { listRules } from './rulesApi';
import { DetailDrawer } from './DetailDrawer';
import { SOURCE_LABELS, SOURCE_TITLES } from './attentionSource';
import './Workbench.css';

interface WorkbenchProps {
  /** Opens the read-only rule-configuration modal (owned by App). */
  onOpenRules: () => void;
  /** Opens the AI attention-semantic configuration modal (owned by App, issue #88). */
  onOpenAiSemantics?: () => void;
  /** Opens the notification-configuration modal (owned by App). Optional for compat. */
  onOpenNotifications?: () => void;
  /** Opens the user-management modal (owned by App). undefined when the current user lacks USER_ADMIN - button hidden (server still enforces via RolesGuard). */
  onOpenUsers?: () => void;
}

interface WorkbenchFilters {
  examDateFrom: string;
  examDateTo: string;
  department: string;
  patientTypeCode: string;
  level: '' | MonitorLevelDto;
  examItem: string;
  patientName: string;
  keyword: string;
}

const EMPTY_FILTERS: WorkbenchFilters = {
  examDateFrom: '',
  examDateTo: '',
  department: '',
  patientTypeCode: '',
  level: '',
  examItem: '',
  patientName: '',
  keyword: '',
};

/** Display-only I/O options; see PATIENT_TYPE_CODE_FALLBACK_LABELS below for why this is safe. */
const PATIENT_TYPE_FILTER_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'I', label: '住院' },
  { code: 'O', label: '门诊' },
];

const PAGE_SIZE = 20;

/** Auto-refresh cadence for the exam list/summary (issue #48). */
const AUTO_REFRESH_SECONDS = 60;

const LEVEL_LABELS: Record<MonitorLevelDto, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  UNCLASSIFIED: '未分级',
};

const HEALTH_LABELS: Record<SyncHealthState, string> = {
  HEALTHY: '同步正常',
  DELAYED: '同步延迟',
  FAILED: '同步失败',
  UNKNOWN: '暂无同步记录',
};

const SUMMARY_CARDS: Array<{
  key: keyof MonitorSummaryDto;
  label: string;
  level: '' | MonitorLevelDto;
  tone?: 'red' | 'yellow' | 'green';
}> = [
  { key: 'total', label: '全部', level: '' },
  { key: 'red', label: '红色', level: 'RED', tone: 'red' },
  { key: 'yellow', label: '黄色', level: 'YELLOW', tone: 'yellow' },
  { key: 'green', label: '绿色', level: 'GREEN', tone: 'green' },
  { key: 'unclassified', label: '未分级', level: 'UNCLASSIFIED' },
];

function toQueryFilters(filters: WorkbenchFilters) {
  return {
    examDateFrom: filters.examDateFrom || undefined,
    examDateTo: filters.examDateTo || undefined,
    department: filters.department.trim() || undefined,
    patientTypeCode: filters.patientTypeCode.trim() || undefined,
    level: filters.level || undefined,
    examItem: filters.examItem.trim() || undefined,
    patientName: filters.patientName.trim() || undefined,
    keyword: filters.keyword || undefined,
  };
}

/** Summary cards show the full level distribution under every non-level filter. */
function toSummaryQueryFilters(filters: WorkbenchFilters) {
  return toQueryFilters({ ...filters, level: '' });
}

function validateFilters(filters: WorkbenchFilters): string | null {
  if (Boolean(filters.examDateFrom) !== Boolean(filters.examDateTo)) {
    return '开始与结束日期需同时填写，或都不填写。';
  }
  if (filters.examDateFrom && filters.examDateTo && filters.examDateFrom > filters.examDateTo) {
    return '开始日期不能晚于结束日期。';
  }
  return null;
}

/**
 * Fallback labels for the raw PAADM_Type code when the source dictionary
 * hasn't confirmed a name yet. I/O are the hospital's standard inpatient/
 * outpatient codes and are display-only - never written back or used as
 * a filter/match value, so this doesn't require the source dictionary
 * verification that other patientType values still do.
 */
const PATIENT_TYPE_CODE_FALLBACK_LABELS: Record<string, string> = {
  I: '住院',
  O: '门诊',
};

function formatPatientType(exam: MonitorExamWorkbenchDto): string {
  const { name, code } = exam.patientType;
  if (name && code) return `${name}（${code}）`;
  if (name) return name;
  if (code) {
    const fallback = PATIENT_TYPE_CODE_FALLBACK_LABELS[code];
    return fallback ? `${fallback}（${code}）` : code;
  }
  return '—';
}

/** Quick date-range presets for 检查日期范围 (issue #49). */
const DATE_RANGE_PRESETS: Array<{ key: string; label: string; days: number }> = [
  { key: '1d', label: '近一日', days: 1 },
  { key: '3d', label: '近三日', days: 3 },
  { key: '7d', label: '近一周', days: 7 },
  { key: '30d', label: '近一月', days: 30 },
];

/** Formats a Date as the `YYYY-MM-DD` string `<input type="date">` expects. */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** [from, to] (both inclusive, `YYYY-MM-DD`) for "the last N days including today". */
function dateRangeForPreset(days: number): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  return { from: toDateInputValue(from), to: toDateInputValue(today) };
}

/** Formats an ISO UTC instant as Asia/Shanghai wall time `YYYY-MM-DD HH:mm:ss`. */
function formatSyncTime(iso: string | null): string {
  if (!iso) return '暂无同步记录';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function friendlyError(error: unknown): string {
  if (error instanceof MonitorApiError) return error.message;
  return '请求失败，请检查网络后重试。';
}

export function Workbench({
  onOpenRules,
  onOpenAiSemantics,
  onOpenNotifications,
  onOpenUsers,
}: WorkbenchProps): JSX.Element {
  const [items, setItems] = useState<MonitorExamWorkbenchDto[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<MonitorSummaryDto | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusDto | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<WorkbenchFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<WorkbenchFilters>(EMPTY_FILTERS);
  /** Which 检查日期范围 quick-preset (if any) matches the current filters; cleared on manual date edits. */
  const [dateRangePreset, setDateRangePreset] = useState<string>('');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(AUTO_REFRESH_SECONDS);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [keywordOptions, setKeywordOptions] = useState<string[]>([]);
  /** The 查看详情 button that opened the drawer; receives focus back on close. */
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!detailId && detailTriggerRef.current) {
      detailTriggerRef.current.focus();
      detailTriggerRef.current = null;
    }
  }, [detailId]);

  const query = useMemo(
    () => ({ ...toQueryFilters(appliedFilters), page, pageSize: PAGE_SIZE }),
    [appliedFilters, page],
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listResult, summaryResult] = await Promise.all([
        listExams(query),
        getExamSummary(toSummaryQueryFilters(appliedFilters)),
      ]);
      setItems(listResult.items);
      setTotal(listResult.total);
      setSummary(summaryResult);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [query, appliedFilters]);

  const loadSyncStatus = useCallback(async () => {
    setSyncFailed(false);
    try {
      setSyncStatus(await getSyncStatus());
    } catch {
      setSyncStatus(null);
      setSyncFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Resets to AUTO_REFRESH_SECONDS on every reload (manual click or the
  // tick below), then counts down once a second and triggers the next
  // auto-refresh at zero. Paused while the tab isn't visible so a
  // backgrounded tab doesn't pile up refresh requests nobody sees.
  useEffect(() => {
    setSecondsUntilRefresh(AUTO_REFRESH_SECONDS);
    const interval = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      setSecondsUntilRefresh((seconds) => {
        if (seconds <= 1) {
          setReloadKey((c) => c + 1);
          return AUTO_REFRESH_SECONDS;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [reloadKey]);

  useEffect(() => {
    void loadSyncStatus();
  }, [loadSyncStatus, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    listRules({ isEnabled: true, pageSize: 200 })
      .then((result) => {
        if (cancelled) return;
        const distinct = Array.from(new Set(result.items.map((rule) => rule.keyword))).sort(
          (a, b) => a.localeCompare(b, 'zh-CN'),
        );
        setKeywordOptions(distinct);
      })
      .catch(() => {
        // Non-fatal: the keyword dropdown just stays empty (still usable
        // for name-only search); the main record/summary load surfaces
        // its own error banner independently.
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function applyFilters(next: WorkbenchFilters): void {
    const validationError = validateFilters(next);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPage(1);
    setAppliedFilters(next);
  }

  function selectLevel(level: '' | MonitorLevelDto): void {
    setFilters((current) => ({ ...current, level }));
    applyFilters({ ...appliedFilters, level });
  }

  function resetFilters(): void {
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setAppliedFilters(EMPTY_FILTERS);
    setDateRangePreset('');
    setError(null);
  }

  function selectDateRangePreset(preset: { key: string; days: number }): void {
    // Clicking the already-active preset toggles it off, clearing the date range.
    if (dateRangePreset === preset.key) {
      const cleared = { ...filters, examDateFrom: '', examDateTo: '' };
      setFilters(cleared);
      setDateRangePreset('');
      applyFilters(cleared);
      return;
    }
    const { from, to } = dateRangeForPreset(preset.days);
    const next = { ...filters, examDateFrom: from, examDateTo: to };
    setFilters(next);
    setDateRangePreset(preset.key);
    applyFilters(next);
  }

  const syncHealth = syncStatus?.health ?? null;
  const syncLine = syncFailed
    ? '同步状态获取失败'
    : syncHealth === null || syncHealth === 'UNKNOWN'
      ? '暂无同步记录'
      : `${HEALTH_LABELS[syncHealth]} · 最后同步时间 ${formatSyncTime(syncStatus?.lastSuccessAt ?? null)}`;

  return (
    <section className="workbench" aria-label="内镜监测工作台">
      <header className="workbench__heading">
        <div>
          <p className="workbench__kicker">ENDOSCOPY MONITORING</p>
          <h1>内镜中心</h1>
          <p className="workbench__subtitle">内镜重点患者监测系统</p>
        </div>
        <div className="workbench__toolbar">
          <span className="workbench__sync">{syncLine}</span>
          <span className="workbench__countdown">{secondsUntilRefresh} 秒后刷新</span>
          <button className="button" type="button" onClick={() => setReloadKey((c) => c + 1)}>
            立即刷新
          </button>
          <button className="button button--primary" type="button" onClick={onOpenRules}>
            关键词监控
          </button>
          {onOpenAiSemantics && (
            <button className="button" type="button" onClick={onOpenAiSemantics}>
              AI 语义监控
            </button>
          )}
          {onOpenNotifications && (
            <button className="button" type="button" onClick={onOpenNotifications}>
              消息推送
            </button>
          )}
          {onOpenUsers && (
            <button className="button" type="button" onClick={onOpenUsers}>
              用户管理
            </button>
          )}
        </div>
      </header>

      <form
        className="workbench__filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters(filters);
        }}
      >
        <label className="workbench__date-range">
          检查日期范围
          <span className="workbench__date-inputs">
            <input
              type="date"
              value={filters.examDateFrom}
              onChange={(event) => {
                setDateRangePreset('');
                setFilters({ ...filters, examDateFrom: event.target.value });
              }}
              aria-label="开始日期"
            />
            <span aria-hidden="true">至</span>
            <input
              type="date"
              value={filters.examDateTo}
              onChange={(event) => {
                setDateRangePreset('');
                setFilters({ ...filters, examDateTo: event.target.value });
              }}
              aria-label="结束日期"
            />
          </span>
          <span className="workbench__date-presets" role="group" aria-label="快捷日期范围">
            {DATE_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={
                  dateRangePreset === preset.key
                    ? 'workbench__date-preset workbench__date-preset--active'
                    : 'workbench__date-preset'
                }
                onClick={() => selectDateRangePreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </span>
        </label>
        <label>
          科室
          <input
            value={filters.department}
            onChange={(event) => setFilters({ ...filters, department: event.target.value })}
            placeholder="科室名称"
          />
        </label>
        <label>
          患者类型
          <select
            value={filters.patientTypeCode}
            onChange={(event) => setFilters({ ...filters, patientTypeCode: event.target.value })}
          >
            <option value="">全部类型</option>
            {PATIENT_TYPE_FILTER_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          关注等级
          <select
            value={filters.level}
            onChange={(event) =>
              setFilters({ ...filters, level: event.target.value as WorkbenchFilters['level'] })
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
          检查项目
          <input
            value={filters.examItem}
            onChange={(event) => setFilters({ ...filters, examItem: event.target.value })}
            placeholder="如胃镜 / 肠镜"
          />
        </label>
        <label>
          姓名
          <input
            value={filters.patientName}
            onChange={(event) => setFilters({ ...filters, patientName: event.target.value })}
            placeholder="患者姓名"
            title="仅搜索患者姓名，不搜索报告正文。"
          />
        </label>
        <label>
          命中关键词
          <select
            value={filters.keyword}
            onChange={(event) => setFilters({ ...filters, keyword: event.target.value })}
            title="按监测规则库中的关键词筛选，不搜索报告正文。"
          >
            <option value="">全部关键词</option>
            {keywordOptions.map((keyword) => (
              <option key={keyword} value={keyword}>
                {keyword}
              </option>
            ))}
          </select>
        </label>
        <div className="workbench__filter-actions">
          <button className="button button--primary" type="submit">
            查询
          </button>
          <button className="button" type="button" onClick={resetFilters}>
            重置
          </button>
        </div>
      </form>

      {error && (
        <div className="feedback feedback--error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="workbench__cards" aria-label="关注等级汇总">
        {SUMMARY_CARDS.map((card) => (
          <button
            key={card.key}
            className={`workbench-card${card.tone ? ` workbench-card--${card.tone}` : ''}${appliedFilters.level === card.level ? ' workbench-card--active' : ''}`}
            type="button"
            onClick={() => selectLevel(card.level)}
          >
            <span className="workbench-card__label">{card.label}</span>
            <strong className="workbench-card__value">{summary?.[card.key] ?? 0}</strong>
          </button>
        ))}
      </div>

      <div className="workbench__table-wrap">
        {loading ? (
          <div className="workbench-state">正在加载检查记录…</div>
        ) : error && items.length === 0 ? (
          <div className="workbench-state">
            <p>检查记录加载失败</p>
            <button className="button" type="button" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="workbench-state">
            <p>没有符合条件的检查记录</p>
            <span>调整筛选条件后重试。</span>
          </div>
        ) : (
          <table className="workbench__table">
            <thead>
              <tr>
                <th>关注等级</th>
                <th>姓名</th>
                <th>科室</th>
                <th>床号</th>
                <th>类型</th>
                <th>检查项目</th>
                <th>检查日期</th>
                <th>检查时间</th>
                <th>命中关键词</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((exam) => (
                <tr
                  key={exam.recordId}
                  className={`workbench__row workbench__row--${exam.monitorLevel.toLowerCase()}`}
                >
                  <td>
                    <span className={`level-tag level-tag--${exam.monitorLevel.toLowerCase()}`}>
                      {LEVEL_LABELS[exam.monitorLevel]}
                    </span>
                    {/*
                      来源徽标（issue #88）放在关注等级单元格内，10 列的表格不再加列。
                      纯文字，颜色不是唯一的信息通道。NONE（两条路径都没发现，等级为
                      未分级）不渲染，避免一排噪音。
                    */}
                    {exam.attentionSource !== 'NONE' && (
                      <span
                        className="source-badge"
                        title={SOURCE_TITLES[exam.attentionSource]}
                      >
                        {SOURCE_LABELS[exam.attentionSource]}
                      </span>
                    )}
                  </td>
                  <td>{exam.patientName ?? '—'}</td>
                  <td>{exam.department ?? '—'}</td>
                  <td>{exam.bedNo ?? '—'}</td>
                  <td>{formatPatientType(exam)}</td>
                  <td>{exam.examItem ?? '—'}</td>
                  <td>{exam.examDate ?? '—'}</td>
                  <td>{exam.examTime ?? '—'}</td>
                  <td className="workbench__keywords">
                    {exam.matchedKeywords.length > 0 ? exam.matchedKeywords.join('、') : '—'}
                  </td>
                  <td>
                    <button
                      className="table-actions"
                      type="button"
                      onClick={(event) => {
                        detailTriggerRef.current = event.currentTarget;
                        setDetailId(exam.recordId);
                      }}
                    >
                      查看详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && total > 0 && (
          <nav className="workbench__pagination" aria-label="检查记录分页">
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

      <DetailDrawer recordId={detailId} onClose={() => setDetailId(null)} />
    </section>
  );
}
