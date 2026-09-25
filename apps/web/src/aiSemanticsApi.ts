import type {
  AttentionSemanticDto,
  CreateAttentionSemanticBody,
  ImportAttentionSemanticsResult,
  ListAttentionSemanticsQuery,
  PaginatedAttentionSemantics,
  UpdateAttentionSemanticBody,
} from '@epgs/shared-types';

// Relative to the current origin - see apps/web/src/authApi.ts for why.
const API_BASE_URL = '';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class AiSemanticsApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AiSemanticsApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorEnvelope;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('epgs:auth-required'));
    const error = (body as ErrorEnvelope).error;
    throw new AiSemanticsApiError(
      error?.message ?? '请求失败，请稍后重试',
      error?.code ?? 'HTTP_ERROR',
      response.status,
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

export async function listAiSemantics(
  query: ListAttentionSemanticsQuery,
): Promise<PaginatedAttentionSemantics> {
  const params = new URLSearchParams();
  if (query.name) params.set('name', query.name);
  if (query.attentionLevel) params.set('attentionLevel', query.attentionLevel);
  if (query.isEnabled !== undefined) params.set('isEnabled', String(query.isEnabled));
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/attention-semantics?${params.toString()}`, {
      credentials: 'include',
    }),
  );
}

export async function createAiSemantic(
  body: CreateAttentionSemanticBody,
): Promise<AttentionSemanticDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/attention-semantics`, jsonRequest('POST', body)),
  );
}

export async function updateAiSemantic(
  id: string,
  body: UpdateAttentionSemanticBody,
): Promise<AttentionSemanticDto> {
  return parseResponse(
    await fetch(`${API_BASE_URL}/api/attention-semantics/${id}`, jsonRequest('PUT', body)),
  );
}

/**
 * Load the hospital's preset attention semantics.
 *
 * The only way presets ever become configuration - nothing writes them
 * automatically - so this is always a deliberate press of a button, and
 * `overwriteExisting` is a separate, explicitly-chosen option because it
 * re-colours entries a doctor may have already reviewed.
 */
export async function importDefaultAiSemantics(
  overwriteExisting: boolean,
  actorId: string,
): Promise<ImportAttentionSemanticsResult> {
  return parseResponse(
    await fetch(
      `${API_BASE_URL}/api/attention-semantics/import-defaults`,
      jsonRequest('POST', { overwriteExisting, actorId }),
    ),
  );
}
