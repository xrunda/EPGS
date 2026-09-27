import { ConfigService } from '@nestjs/config';
import { ClassifyReportDeps } from '@epgs/ai-semantic';
import {
  buildSemanticModelClient,
  readSemanticModelSettings,
} from '../semantic/semantic-model.factory';

/**
 * DI token for the classifier's dependencies (issue #88).
 *
 * Same reasoning as #87's SEMANTIC_JUDGE_DEPS: it lives in its own file so the
 * module can import the service without a cycle, and it is the seam a spec
 * replaces with a fake client - no test here needs a gateway, a key or a
 * network.
 */
export const SEMANTIC_CLASSIFY_DEPS = Symbol('SEMANTIC_CLASSIFY_DEPS');

/**
 * Config -> task-deps assembly for the report classifier (issue #88).
 *
 * REUSES #87's gateway plumbing wholesale: the same SEMANTIC_MODEL_BASE_URL /
 * API_KEY / NAME / API_STYLE variables and the very same
 * `buildSemanticModelClient`. That is intentional - a hospital has ONE model
 * gateway, and giving the two tasks separate connection settings would mean two
 * places to configure, two places to get wrong, and a deployment where one task
 * works and the other silently does not.
 *
 * What differs is only the shape of a call, because a whole report is a much
 * larger input than one sentence: a longer timeout, a larger token budget, and a
 * report-size cap (#87's context window is a slice; here the whole report is
 * sent). Those have their own SEMANTIC_REPORT_* variables.
 *
 * FAIL-SAFE APPLIES TO CONFIGURATION TOO - and for the same reason spelled out
 * in semantic-model.factory.ts: this process also runs the sync job and the push
 * scheduler, so a missing model URL must disable the classifier loudly rather
 * than stop the worker from booting. A deployment that never opted in is
 * reported without complaint.
 */
export function readClassifyReportDeps(config: ConfigService): {
  deps: ClassifyReportDeps | null;
  missing: string[];
} {
  const { settings, missing } = readSemanticModelSettings(config);
  if (settings === null) {
    return { deps: null, missing };
  }

  return {
    deps: {
      client: buildSemanticModelClient(settings),
      model: settings.model,
      timeoutMs: config.get<number>('semanticReportTimeoutMs', 20_000),
      maxTokens: config.get<number>('semanticReportMaxTokens', 1024),
      reportMaxChars: config.get<number>('semanticReportMaxChars', 20_000),
    },
    missing: [],
  };
}
