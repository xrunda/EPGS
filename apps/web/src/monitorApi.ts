import type {
  ListMonitorExamsQuery,
  MonitorExamWorkbenchDetailDto,
  MonitorFiltersQuery,
  MonitorLevelDto,
  MonitorSummaryDto,
  MonitorSummaryQuery,
  PaginatedMonitorExams,
  SyncStatusDto,
} from '@epgs/shared-types';
// 等级文案只有一个来源（attentionSource.ts）；导出文件名里的等级段必须与屏幕上、
// 与后端 CSV 表头下的等级列用的是同一份映射。
import { ATTENTION_LEVEL_LABELS, orderAttentionLevels } from './attentionSource';

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class MonitorApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MonitorApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new MonitorApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }
  return body as T;
}

/** Appends only the filters that are actually set (empty strings are dropped). */
function toQueryString(query: MonitorFiltersQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.examDateFrom) params.set('examDateFrom', query.examDateFrom);
  if (query.examDateTo) params.set('examDateTo', query.examDateTo);
  if (query.department) params.set('department', query.department);
  if (query.patientTypeCode) params.set('patientTypeCode', query.patientTypeCode);
  if (query.level) params.set('level', query.level);
  if (query.examItem) params.set('examItem', query.examItem);
  if (query.patientName) params.set('patientName', query.patientName);
  if (query.keyword) params.set('keyword', query.keyword);
  return params;
}

export async function listExams(query: ListMonitorExamsQuery): Promise<PaginatedMonitorExams> {
  const params = toQueryString(query);
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  if (query.sortBy) params.set('sortBy', query.sortBy);
  if (query.sortDir) params.set('sortDir', query.sortDir);
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/exams?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function getExamSummary(query: MonitorSummaryQuery): Promise<MonitorSummaryDto> {
  const params = toQueryString(query);
  const queryString = params.toString();
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/summary${queryString ? `?${queryString}` : ''}`, {
      credentials: 'include',
    }),
  );
}

/**
 * The workbench detail. Note the return type is the WORKBENCH extension, not the
 * base MonitorExamDetailDto: this endpoint is what carries attentionSource /
 * aiJudged / aiSemantics, and the alert H5 page does NOT come through here (it
 * has its own job and its own base-typed client, issue #88).
 */
export async function getExamDetail(id: string): Promise<MonitorExamWorkbenchDetailDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/monitor/exams/${encodeURIComponent(id)}`, {
      credentials: 'include',
    }),
  );
}

export async function getSyncStatus(): Promise<SyncStatusDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/system/sync-status`, { credentials: 'include' }),
  );
}

/* ── 单日、多等级明细导出（issue #139；多选见 #145） ───────────────────────── */

/**
 * 下载文件名，例如 `数据导出-2026-08-20-红色关注+黄色关注.csv`。
 *
 * 与后端 `apps/api/src/monitor/monitor-csv.ts` 的 `csvFileName` 是**一对双胞胎**：
 * fetch + blob 下载时浏览器用的是我们自己设的 `anchor.download`，
 * `Content-Disposition` 根本读不到（它是给 `curl -OJ` 和直接 GET 用的），
 * 所以两边必须给出同一个名字。改一边就得改另一边。
 *
 * 先在本地归一化（去重 + 规范顺序），这样 URL、请求参数与文件名三者用的是同一个
 * 顺序 —— 服务端也会归一化一次，两边不会因为顺序不同而给出不同的名字。
 */
export function exportFileName(examDate: string, levels: readonly MonitorLevelDto[]): string {
  const labels = orderAttentionLevels(levels).map((level) => ATTENTION_LEVEL_LABELS[level]);
  return `数据导出-${examDate}-${labels.join('+')}.csv`;
}

export interface ExportedExamsCsv {
  blob: Blob;
  fileName: string;
  /**
   * 服务端 `X-Row-Count`，即文件里的数据行数（不含表头）。
   *
   * **读不到时是 `null`，不是 0**：这个头今天同源可得，但将来若前端拆到别的域，
   * 没进 CORS `exposedHeaders` 的头会静默消失。把「读不到」当成 0 会让一个正常
   * 文件被当成空结果丢掉，所以两者必须分得开，由调用方决定怎么处理。
   */
  rowCount: number | null;
}

/**
 * 取回某一天、若干关注等级的明细 CSV。**不复用 `parseResponse`**：那个函数无条件
 * `await response.json()`，而成功响应是二进制/文本流，`json()` 会直接抛错。
 *
 * 失败仍然是 JSON 错误信封（服务端用 StreamableFile，异常过滤器照常兜底），
 * 所以这里手写一遍等价分支：401 派发 `epgs:auth-required`，403
 * `PATIENT_DETAIL_REQUIRED` 的 message 由弹层直接显示。
 *
 * 返回 blob 而不是在这里触发下载：落不落盘是界面决定（0 行时不该产生一个空文件），
 * 而且把 DOM 副作用留在组件里更便于测试。
 */
export async function downloadExamsCsv(query: {
  examDate: string;
  levels: readonly MonitorLevelDto[];
}): Promise<ExportedExamsCsv> {
  const levels = orderAttentionLevels(query.levels);
  // 逗号分隔的**一个**参数（不是重复参数）：服务端 DTO 就是这么读的，而且
  // `?levels=RED,YELLOW` 在日志与审计里是一眼能看懂的形状。
  const params = new URLSearchParams({ examDate: query.examDate, levels: levels.join(',') });
  const response = await fetch(`${API_BASE_URL}/api/monitor/export?${params.toString()}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    // 反代/网闸挡在前面时回来的可能是一页 HTML 而不是信封，`.json()` 会抛 ——
    // 那种情况按「请求失败」处理，别把解析错误当成业务错误抛给用户。
    let code = 'HTTP_ERROR';
    let message = '导出失败，请稍后重试';
    try {
      const body = (await response.json()) as ErrorEnvelope;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // 保持上面的默认值
    }
    throw new MonitorApiError(message, code, response.status);
  }

  const rawRowCount = response.headers.get('X-Row-Count');
  const parsed = rawRowCount === null ? Number.NaN : Number(rawRowCount);
  return {
    blob: await response.blob(),
    fileName: exportFileName(query.examDate, levels),
    rowCount: Number.isInteger(parsed) ? parsed : null,
  };
}
