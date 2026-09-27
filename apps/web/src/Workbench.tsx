import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MonitorExamWorkbenchDto,
  MonitorLevelDto,
  MonitorSummaryDto,
  SyncHealthState,
  SyncStatusDto,
} from '@epgs/shared-types';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { getExamSummary, listExams, MonitorApiError, getSyncStatus } from './monitorApi';
import { listRules } from './rulesApi';
import { DetailDrawer } from './DetailDrawer';
import { ATTENTION_LEVEL_LABELS } from './attentionSource';
import { findingSourceIcons } from './findingSource';
import { rowAttentionReason } from './attentionReason';
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
  /** Opens the level-conflict list (owned by App, issue #103). undefined when the current user lacks RULE_ADMIN. */
  onOpenLevelConflicts?: () => void;
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
  onOpenLevelConflicts,
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

  /*
    低频入口（issue #116）：消息推送 / 等级分歧 / 用户管理 收进「⋯」，工具栏只留
    关键词监控与 AI 语义监控两个显性按钮。三者各自的条件渲染原封不动地搬进来 ——
    prop 没传（App.tsx 按角色决定传不传）就不进这个数组，菜单里也就不会有那一项，
    不会出现点了没反应的入口。
  */
  const toolbarMenuItems: ActionMenuItem[] = [];
  if (onOpenNotifications) {
    toolbarMenuItems.push({ label: '消息推送', onSelect: onOpenNotifications });
  }
  if (onOpenLevelConflicts) {
    toolbarMenuItems.push({ label: '等级分歧', onSelect: onOpenLevelConflicts });
  }
  if (onOpenUsers) {
    toolbarMenuItems.push({ label: '用户管理', onSelect: onOpenUsers });
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
        <div className="workbench__brand">
          {/*
            产品标识（issue #114）。装饰性图片用 alt=""：右边 h1 已经把「内镜中心」
            说了一遍，读屏再念一次同一个名字是噪音。医院 logo 在顶栏，这里小一号，
            两个不打架。
          */}
          <img className="workbench__logo" src="/logo.png" alt="" />
          <div>
            <h1>内镜中心</h1>
            <p className="workbench__subtitle">内镜重点患者监测系统</p>
          </div>
        </div>
        <div className="workbench__toolbar">
          <span className="workbench__sync">{syncLine}</span>
          {/*
            配置入口的按钮文案（issue #114，改动 #94 划的线）：入口文字与它打开的
            弹层标题逐字一致 —— 写着「监测规则」点开却是「关键词监控」，用户不知道
            点下去是什么。所有者 2026-09-27 定的新规矩。
            代价是工作台的设置工具栏里重新出现机制词；#94 那条「临床视图不出现机制
            词」的保证改为由 Workbench.test.tsx 的术语扫描把这排工具栏排除后来守，
            医生真正在读的内容（等级、理由、依据）一个机制词都不许有。
            只改字：目标弹窗、权限、行为一律不变。
          */}
          {/*
            两个入口都不实心（issue #125）。原来是「关键词监控」带 .button--primary、
            「AI 语义监控」不带，从 #9 带过来的：那时工具栏只有这一个入口，实心是在
            强调主操作。#88 加了平级的 AI 入口、#116 又把其余入口收进「⋯」之后，
            这个强调就成了没来由的偏袒 —— 两个按钮都只是「点开某个配置弹层」，谁也不
            比谁更当前，实心那个看起来却像已选中的标签页。
            更深一层的理由是 .button--primary 在产品里只该有一个含义：**表单里的确认
            动作**（查询、新建、确认载入）。借用它来表示「入口」是同一套视觉语言指两
            件事。入口不表示任何状态，弹层开了关了外观都不变，所以它不该有状态外观。
          */}
          <button className="button" type="button" onClick={onOpenRules}>
            关键词监控
          </button>
          {onOpenAiSemantics && (
            <button className="button" type="button" onClick={onOpenAiSemantics}>
              AI 语义监控
            </button>
          )}
          {/*
            消息推送 / 等级分歧 / 用户管理 收进「⋯」（issue #116）。这三个是配置与
            管理侧的低频入口，和上面两个价值点并排只会把主功能稀释掉。文案、目标
            弹窗、角色判定一律不变，只是换了入口位置。
            三项都没得显示时整个「⋯」不渲染 —— 一个展开后空无一物的按钮比没有按钮
            更糟。
            术语扫描不受影响：菜单项都不含机制词，而且菜单挂在 .workbench__toolbar
            里面，扫描本来就把这一整块摘掉再扫（见 Workbench.test.tsx）。
          */}
          {toolbarMenuItems.length > 0 && (
            <ActionMenu
              label="更多配置"
              items={toolbarMenuItems}
              /* 浅底外观复用现成的 .button，跟旁边两个按钮同一个形状 */
              triggerClassName="button workbench__menu-trigger"
            />
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

      <div className="workbench__list">
        {/*
          列表自己的工具条（issue #114）：刷新的就是这个列表，控件就摆在它右上角，
          不用再猜「立即刷新」刷的是谁。倒计时一起搬过来 —— 它讲的就是这个列表的
          自动刷新，留在顶栏那排设置按钮里是个孤儿。
          「同步正常 · 最后同步时间」留在页头：那是院内网关的同步健康，不是列表的开关。
        */}
        <div className="workbench__list-tools">
          <span className="workbench__countdown">{secondsUntilRefresh} 秒后刷新</span>
          <button
            className="workbench__refresh"
            type="button"
            aria-label="刷新列表"
            title="刷新列表"
            onClick={() => setReloadKey((c) => c + 1)}
          >
            {/* 圆形箭头是通用图形，不必配文字。内联 SVG —— 仓库里没有图标库。 */}
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
              <path
                d="M13.2 8a5.2 5.2 0 1 1-1.52-3.68"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M13.3 1.9v2.7h-2.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
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
                  <th>发现来源</th>
                  <th>姓名</th>
                  <th>科室</th>
                  <th>床号</th>
                  <th>类型</th>
                  <th>检查项目</th>
                  <th>检查日期</th>
                  <th>检查时间</th>
                  <th>关注理由</th>
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
                      {/*
                      等级文字带「关注」二字（attentionSource.ts 是唯一来源）：红色是
                      管理上的关注等级，不是病情严重程度，行内也不能只留一个颜色词。
                    */}
                      <span className={`level-tag level-tag--${exam.monitorLevel.toLowerCase()}`}>
                        {ATTENTION_LEVEL_LABELS[exam.monitorLevel]}
                      </span>
                    </td>
                    {/*
                      发现来源（issue #112）：这一行是哪一路发现的。单独一列而不是塞进
                      「关注等级」格子里 —— 图标跟着色标宽度跑的话，「红色关注」和「未分级」
                      的图标起止位置差十几个像素，竖着扫会抖；单独一列两枚图标上下对齐。
                      图标不带文字（见 findingSource.ts），同一件事的完整说法在右边
                      「关注理由」列里，图标是它的可扫版本。
                    */}
                    <td className="workbench__source">
                      {/*
                        NONE 是唯一没有图标的来源（findingSource.ts 的 switch 已经穷举了
                        四个取值），所以这里显式判它、渲染占位符：留空会被读成没渲染出来。
                        findingSource.test.ts 钉住「非 NONE 至少一枚图标」，两边不会漂。
                      */}
                      {exam.attentionSource === 'NONE' ? (
                        <span className="workbench__source-none">—</span>
                      ) : (
                        <span className="workbench__source-icons">
                          {findingSourceIcons(exam.attentionSource).map((icon) => (
                            <span
                              className="workbench__source-tip"
                              key={icon.src}
                              data-tip={icon.tip}
                            >
                              <img
                                className="workbench__source-icon"
                                src={icon.src}
                                alt={icon.alt}
                              />
                            </span>
                          ))}
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
                    {/*
                      关注理由（issue #94）：这一列回答「为什么这位患者需要我关注」。
                      理由句由 attentionReason.ts 拼出，没有理由的行显示占位符，不编造
                      理由。来源徽标（issue #88 的文字徽标）仍然不在这里 —— 左边「发现来源」
                      那列是图标，两者说的是同一件事的两种表达（issue #112）。
                    */}
                    <td className="workbench__reason">{rowAttentionReason(exam) ?? '—'}</td>
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
      </div>

      <DetailDrawer recordId={detailId} onClose={() => setDetailId(null)} />
    </section>
  );
}
