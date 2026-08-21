import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MonitorExamDto,
  MonitorLevelDto,
  MonitorSummaryDto,
  SyncHealthState,
  SyncStatusDto,
} from '@epgs/shared-types';
import { getExamSummary, listExams, MonitorApiError, getSyncStatus } from './monitorApi';
import { DetailDrawer } from './DetailDrawer';
import './Workbench.css';

interface WorkbenchProps {
  /** Opens the read-only rule-configuration modal (owned by App). */
  onOpenRules: () => void;
}

interface WorkbenchFilters {
  examDateFrom: string;
  examDateTo: string;
  department: string;
  patientTypeCode: string;
  level: '' | MonitorLevelDto;
  examItem: string;
  q: string;
}

const EMPTY_FILTERS: WorkbenchFilters = {
  examDateFrom: '',
  examDateTo: '',
  department: '',
  patientTypeCode: '',
  level: '',
  examItem: '',
  q: '',
};

const PAGE_SIZE = 20;

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
}> = [
  { key: 'total', label: '全部', level: '' },
  { key: 'red', label: '红色', level: 'RED' },
  { key: 'yellow', label: '黄色', level: 'YELLOW' },
  { key: 'green', label: '绿色', level: 'GREEN' },
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
    q: filters.q.trim() || undefined,
  };
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

function formatPatientType(exam: MonitorExamDto): string {
  const { name, code } = exam.patientType;
  if (name && code) return `${name}（${code}）`;
  return name ?? code ?? '—';
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

export function Workbench({ onOpenRules }: WorkbenchProps): JSX.Element {
  const [items, setItems] = useState<MonitorExamDto[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<MonitorSummaryDto | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusDto | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<WorkbenchFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<WorkbenchFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
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
        getExamSummary(toQueryFilters(appliedFilters)),
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

  useEffect(() => {
    void loadSyncStatus();
  }, [loadSyncStatus, reloadKey]);

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
    setError(null);
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
          <button className="button" type="button" onClick={() => setReloadKey((c) => c + 1)}>
            立即刷新
          </button>
          <button className="button button--primary" type="button" onClick={onOpenRules}>
            监测规则
          </button>
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
              onChange={(event) => setFilters({ ...filters, examDateFrom: event.target.value })}
              aria-label="开始日期"
            />
            <span aria-hidden="true">至</span>
            <input
              type="date"
              value={filters.examDateTo}
              onChange={(event) => setFilters({ ...filters, examDateTo: event.target.value })}
              aria-label="结束日期"
            />
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
          <input
            value={filters.patientTypeCode}
            onChange={(event) => setFilters({ ...filters, patientTypeCode: event.target.value })}
            placeholder="如 I / O"
          />
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
          姓名 / 关键词
          <input
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            placeholder="姓名或命中关键词"
            title="仅搜索患者姓名和命中的关键词，不搜索报告正文。"
          />
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
            className={`workbench-card${appliedFilters.level === card.level ? ' workbench-card--active' : ''}`}
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
                <tr key={exam.recordId}>
                  <td>
                    <span className={`level-tag level-tag--${exam.monitorLevel.toLowerCase()}`}>
                      {LEVEL_LABELS[exam.monitorLevel]}
                    </span>
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
