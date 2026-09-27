import { ConfigService } from '@nestjs/config';
import {
  OpenAiCompatibleChatClient,
  SEMANTIC_MODEL_API_STYLES,
  SemanticModelApiStyle,
  SemanticModelClient,
  ValidateMatchDeps,
} from '@epgs/ai-semantic';

/**
 * DI token for the task's dependencies - the model client plus the call
 * settings.
 *
 * Lives in this file rather than in semantic.module.ts to keep the dependency
 * acyclic: the module imports the service, and the service needs this token, so
 * a token defined in the module would be read before it is initialized. The
 * provider is what makes the model seam swappable - a spec supplies a fake
 * client through this token and no test needs a gateway, a key or a network.
 */
export const SEMANTIC_JUDGE_DEPS = Symbol('SEMANTIC_JUDGE_DEPS');

/** Shorthand for the provider's value: null means "judge off or unconfigured". */
export type SemanticJudgeDeps = ValidateMatchDeps | null;

/**
 * Config -> model-client assembly for the semantic judge (issue #87).
 *
 * Kept separate from the module so the `semantic:probe` CLI can build the very
 * same client the judge would use - probing a gateway with different code than
 * the one that will call it in production would prove nothing.
 *
 * FAIL-OPEN APPLIES TO CONFIGURATION TOO. Missing model settings are REPORTED,
 * never thrown: this repository's other integrations validate their variables
 * with Joi `required` and fail the boot, which is right for the PACS adapter
 * (nothing works without it), but wrong here. The worker also runs the sync
 * job that feeds patient monitoring (issue #6); refusing to boot because a
 * model gateway URL is missing would turn the optional AI layer into a
 * single point of failure for the whole system, which issue #87 forbids
 * outright. So the judge disables itself, says loudly why, and the worker
 * keeps syncing with the original keyword behaviour intact.
 */

/** Everything the judge needs to reach a model, read from config in one place. */
export interface SemanticModelSettings {
  baseUrl: string;
  /** Never logged, never persisted. */
  apiKey?: string;
  /** Model identifier sent to the gateway and recorded on every audit row. */
  model: string;
  apiStyle: SemanticModelApiStyle;
  timeoutMs: number;
  maxTokens: number;
  /** Context window budget in characters (see @epgs/ai-semantic context.ts). */
  contextCharBudget: number;
}

/**
 * Resolve the model settings, or name the variables that are missing.
 *
 * @returns `{ settings: null, missing: [...] }` when the deployment has not
 *          been configured yet - the caller logs the names and disables the
 *          judge. Never throws, and never includes a VALUE in `missing`
 *          (SEMANTIC_MODEL_API_KEY is a credential).
 */
export function readSemanticModelSettings(config: ConfigService): {
  settings: SemanticModelSettings | null;
  missing: string[];
} {
  const baseUrl = (config.get<string>('semanticModelBaseUrl') ?? '').trim();
  const model = (config.get<string>('semanticModelName') ?? '').trim();

  const missing: string[] = [];
  if (baseUrl.length === 0) missing.push('SEMANTIC_MODEL_BASE_URL');
  if (model.length === 0) missing.push('SEMANTIC_MODEL_NAME');
  if (missing.length > 0) return { settings: null, missing };

  const apiKey = (config.get<string>('semanticModelApiKey') ?? '').trim();
  const configuredStyle = config.get<string>('semanticModelApiStyle') ?? 'openai-chat';

  return {
    settings: {
      baseUrl,
      ...(apiKey.length > 0 ? { apiKey } : {}),
      model,
      apiStyle: SEMANTIC_MODEL_API_STYLES.includes(configuredStyle as SemanticModelApiStyle)
        ? (configuredStyle as SemanticModelApiStyle)
        : 'openai-chat',
      timeoutMs: config.get<number>('semanticModelTimeoutMs', 10_000),
      maxTokens: config.get<number>('semanticModelMaxTokens', 512),
      contextCharBudget: config.get<number>('semanticContextCharBudget', 400),
    },
    missing: [],
  };
}

/**
 * Build the client for a set of settings.
 *
 * The switch exists so the "only openai-chat is implemented" fact lives in one
 * place the compiler checks: adding the hospital's own protocol later is a new
 * case here plus a value in SEMANTIC_MODEL_API_STYLES, with no change to the
 * judge, the task or the audit trail.
 */
export function buildSemanticModelClient(settings: SemanticModelSettings): SemanticModelClient {
  switch (settings.apiStyle) {
    case 'openai-chat':
      return new OpenAiCompatibleChatClient({
        baseUrl: settings.baseUrl,
        ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
      });
  }
}
