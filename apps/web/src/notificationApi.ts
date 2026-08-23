import type {
  CreateNotificationChannelBody,
  CreateNotificationRuleBody,
  CreateNotificationTemplateBody,
  ListNotificationChannelsQuery,
  ListNotificationRulesQuery,
  ListNotificationTemplatesQuery,
  ListPushLogsQuery,
  NotificationChannelDto,
  NotificationRuleDto,
  NotificationSendFailureDetails,
  NotificationTemplateDto,
  NotificationTemplatePresetDto,
  NotificationVariableDto,
  PaginatedNotificationChannels,
  PaginatedNotificationRules,
  PaginatedNotificationTemplates,
  PaginatedPushLogs,
  RunNotificationRuleResult,
  TestSendBody,
  TestSendResult,
  UpdateNotificationChannelBody,
  UpdateNotificationRuleBody,
  UpdateNotificationTemplateBody,
} from '@epgs/shared-types';

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: NotificationSendFailureDetails;
  };
}

export class NotificationApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: NotificationSendFailureDetails,
  ) {
    super(message);
    this.name = 'NotificationApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new NotificationApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
      error?.details,
    );
  }
  return body as T;
}

function jsonRequest(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** 后端通知错误码 → 可读中文文案（消费方共享，避免三份拷贝）。 */
export function friendlyError(error: unknown): string {
  if (error instanceof NotificationApiError) {
    switch (error.code) {
      case 'NOTIFICATION_CHANNEL_NOT_FOUND':
        return '渠道不存在或已被删除。';
      case 'NOTIFICATION_TEMPLATE_NOT_FOUND':
        return '模板不存在或已被删除。';
      case 'NOTIFICATION_CHANNEL_DISABLED':
        return '渠道已停用，无法发送测试消息。';
      case 'NOTIFICATION_TEMPLATE_DISABLED':
        return '模板已停用，无法发送测试消息。';
      case 'NOTIFICATION_TEMPLATE_TITLE_REQUIRED':
        return 'NEWS 类型模板必须填写标题。';
      case 'NOTIFICATION_SEND_FAILED':
        return error.details?.wecomErrMsg
          ? `企业微信发送失败：${error.details.wecomErrMsg}`
          : '企业微信发送失败，请检查机器人 Webhook 配置后重试。';
      case 'NOTIFICATION_RULE_NOT_FOUND':
        return '推送规则不存在或已被删除。';
      case 'NOTIFICATION_RULE_NO_CHANNELS':
        return '推送规则至少需要绑定一个渠道。';
    }
    return error.message;
  }
  return '请求失败，请检查网络后重试。';
}

/** ISO 时间 → 上海时区 `YYYY-MM-DD HH:mm`（列表列展示用）。 */
export function formatTimestamp(iso: string): string {
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

export async function listChannels(
  query: ListNotificationChannelsQuery,
): Promise<PaginatedNotificationChannels> {
  const params = new URLSearchParams();
  if (query.isEnabled !== undefined) params.set('isEnabled', String(query.isEnabled));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-channels?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function createChannel(
  body: CreateNotificationChannelBody,
): Promise<NotificationChannelDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-channels`, jsonRequest('POST', body)),
  );
}

export async function updateChannel(
  id: string,
  body: UpdateNotificationChannelBody,
): Promise<NotificationChannelDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-channels/${id}`, jsonRequest('PUT', body)),
  );
}

export async function listTemplates(
  query: ListNotificationTemplatesQuery,
): Promise<PaginatedNotificationTemplates> {
  const params = new URLSearchParams();
  if (query.msgType) params.set('msgType', query.msgType);
  if (query.isEnabled !== undefined) params.set('isEnabled', String(query.isEnabled));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-templates?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function createTemplate(
  body: CreateNotificationTemplateBody,
): Promise<NotificationTemplateDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-templates`, jsonRequest('POST', body)),
  );
}

export async function updateTemplate(
  id: string,
  body: UpdateNotificationTemplateBody,
): Promise<NotificationTemplateDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-templates/${id}`, jsonRequest('PUT', body)),
  );
}

export async function getNotificationVariables(): Promise<NotificationVariableDto[]> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-templates/variables`, { credentials: 'include' }),
  );
}

export async function getNotificationTemplatePresets(): Promise<NotificationTemplatePresetDto[]> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-templates/presets`, { credentials: 'include' }),
  );
}

export async function testSend(channelId: string, body: TestSendBody): Promise<TestSendResult> {
  return parseResponse(
    await fetch(
      `${API_BASE_URL}/api/notification-channels/${channelId}/test-send`,
      jsonRequest('POST', body),
    ),
  );
}

// ---- 推送规则（issue: push rules）--------------------------------------------

export async function listRules(
  query: ListNotificationRulesQuery,
): Promise<PaginatedNotificationRules> {
  const params = new URLSearchParams();
  if (query.isEnabled !== undefined) params.set('isEnabled', String(query.isEnabled));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-rules?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function createRule(body: CreateNotificationRuleBody): Promise<NotificationRuleDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-rules`, jsonRequest('POST', body)),
  );
}

export async function updateRule(
  id: string,
  body: UpdateNotificationRuleBody,
): Promise<NotificationRuleDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-rules/${id}`, jsonRequest('PUT', body)),
  );
}

export async function runRule(ruleId: string, windowDate?: string): Promise<RunNotificationRuleResult> {
  const query = windowDate ? `?windowDate=${encodeURIComponent(windowDate)}` : '';
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-rules/${ruleId}/run${query}`, jsonRequest('POST', {})),
  );
}

/** 聚合推送日志（一级「日志」tab）：跨所有规则/模板，最新在前。 */
export async function listAllPushLogs(query: ListPushLogsQuery): Promise<PaginatedPushLogs> {
  const params = new URLSearchParams();
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/notification-push-logs?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}
