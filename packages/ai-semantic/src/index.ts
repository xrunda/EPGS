/**
 * @epgs/ai-semantic - the shared AI semantic engine (issue #87).
 *
 * The lower layer that #87 (Validate Match, here) and the future #88 (Classify
 * Report) both build on: the model-client seam, the structured-output contract
 * with strict validation, evidence verification, the deterministic disposition
 * matrix, the fail-open error taxonomy, audit hashing and task/prompt
 * versioning.
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
