/**
 * The model seam (issue #87).
 *
 * Everything above this file works against `SemanticModelClient`; nothing
 * above it knows about HTTP, gateways, API keys or response envelopes. Two
 * consequences that the issue's testing requirement depends on:
 *
 *  - Unit tests inject a fake client and assert the disposition matrix without
 *    a real model, a network, or a container. Every acceptance sample in
 *    issue #87 is reproducible offline.
 *  - If the hospital's gateway turns out not to be OpenAI-shaped, a second
 *    implementation is added here and nothing else changes. The gateway's
 *    compatibility is an OPEN QUESTION the owner has not been able to answer
 *    yet, which is exactly why this boundary exists rather than the
 *    implementation being called directly.
 */

/** One completion request, fully formed. */
export interface SemanticModelRequest {
  /** Task/system instructions. Fixed text owned by the task, never report data. */
  system: string;
  /** The task input to judge - contains the report excerpt. */
  user: string;
  /** Model identifier as configured. */
  model: string;
  /** Sampling temperature. Always 0 for a judging task. */
  temperature: number;
  /** Upper bound on generated tokens. */
  maxTokens: number;
  /** Abort the call after this many ms. */
  timeoutMs: number;
}

/** One completion response. */
export interface SemanticModelResponse {
  /** The assistant's message content, verbatim. Never logged, never persisted. */
  raw: string;
  /**
   * The revision the gateway reports for the model it actually served, when it
   * reports one at all (e.g. a snapshot id). Some gateways report nothing,
   * hence nullable - the configured `model` is always recorded regardless.
   */
  modelVersion: string | null;
  /** Measured wall-clock duration of the call. */
  latencyMs: number;
}

/**
 * A model that can answer a completion. Implementations must reject with a
 * `SemanticError` (see errors.ts) so the caller can classify the failure
 * without inspecting messages; `classifyModelError` also handles a raw
 * AbortError/TypeError defensively.
 */
export interface SemanticModelClient {
  complete(request: SemanticModelRequest): Promise<SemanticModelResponse>;
}

/**
 * Which wire protocol to speak. Only `openai-chat` is implemented.
 *
 * This exists as a named seam rather than an assumption: the hospital's
 * self-hosted model gateway may not be OpenAI-compatible, and that is not yet
 * known. Adding a second value later is an additive change confined to
 * openai-compatible-chat-client.ts and its env plumbing.
 */
export type SemanticModelApiStyle = 'openai-chat';

/** Runtime list of supported api styles, for env validation. */
export const SEMANTIC_MODEL_API_STYLES: readonly SemanticModelApiStyle[] = ['openai-chat'];
