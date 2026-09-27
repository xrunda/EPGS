import { ConflictException } from '@nestjs/common';

/**
 * Thrown when a PUT's `version` does not match the row's current version, or
 * when the target row has already been superseded by a newer version in its
 * group. Either way the client's view of "which row is current" is stale, and
 * retrying without reloading would fork a second edit history off the same
 * logical semantic (see AttentionSemanticsService.update).
 */
export class AttentionSemanticVersionConflictException extends ConflictException {
  constructor(semanticId: string, expectedVersion: number, actualVersion: number) {
    super({
      code: 'ATTENTION_SEMANTIC_VERSION_CONFLICT',
      message: `Attention semantic ${semanticId} was modified by another operator (expected version ${expectedVersion}, current version is ${actualVersion}). Reload and retry.`,
      details: { conflictingSemanticId: semanticId, expectedVersion, actualVersion },
    });
  }
}
