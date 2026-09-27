/**
 * @epgs/ai-semantic - the shared AI semantic engine (issue #87).
 *
 * The lower layer both AI tasks build on: the model-client seam, the
 * structured-output contract with strict validation, evidence verification, the
 * fail-open error taxonomy, audit hashing and task/prompt versioning. #87
 * (Validate Match, validate-match.ts) uses the deterministic disposition matrix;
 * #88 (Classify Report, classify-report.ts) has no disposition at all, because
 * its findings can only ever be ADDED.
 *
 * Framework- and DB-agnostic, like @epgs/matching-engine: no `@prisma/client`
 * import, no database handle, and no logging. The model is reached through an
 * injected `SemanticModelClient`, so every behaviour in this package is
 * testable without a real model.
 *
 * Reading order for a reviewer new to this package:
 *   types.ts       - the contract, and the model-interprets/code-decides split
 *   disposition.ts - the decision matrix, the only source of `filtered: true`
 *   validate-match.ts - the pipeline and its fail-open paths
 *   context.ts     - why the context window is what it is
 */
export * from './types';
export * from './errors';
export * from './hashing';
export * from './sentence';
export * from './context';
export * from './evidence';
export * from './disposition';
export * from './parse';
export * from './prompt';
export * from './model-client';
export * from './openai-compatible-chat-client';
export { validateMatch } from './validate-match';
export type { ValidateMatchDeps } from './validate-match';

// --- Issue #88: Classify Report ------------------------------------------
export * from './classify-types';
export * from './classify-sections';
export * from './classify-parse';
export * from './classify-prompt';
export { classifyReport, computeAttentionLevel } from './classify-report';
export type { ClassifyReportDeps } from './classify-report';
