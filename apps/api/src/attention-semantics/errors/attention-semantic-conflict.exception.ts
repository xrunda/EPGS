import { ConflictException } from '@nestjs/common';
import { AttentionSemanticConflictDetails } from '@epgs/shared-types';

/**
 * Thrown when a new/edited semantic would duplicate an existing ENABLED
 * semantic's name.
 *
 * Same policy as monitor rules (`assertNoConflict`), and the same reasoning: two
 * enabled entries with the same name are indistinguishable to a doctor reading
 * a report's findings, and the name is what an auditor uses to tell one
 * finding from another. Comparison is case-insensitive and trimmed, so
 * "恶性病变" and " 恶性病变 " are the same semantic.
 *
 * Only the NAME is checked, not the description: two entries may legitimately
 * describe related meanings, and forcing descriptions to differ would push
 * doctors toward wording that is different for no reason.
 *
 * Produces the machine-readable body:
 *   { error: { code: 'ATTENTION_SEMANTIC_CONFLICT', message, correlationId, details } }
 * via GlobalExceptionFilter.
 */
export class AttentionSemanticConflictException extends ConflictException {
  constructor(
    conflictingSemanticId: string,
    message = 'An enabled attention semantic with the same name already exists.',
  ) {
    const details: AttentionSemanticConflictDetails = { conflictingSemanticId };
    super({
      code: 'ATTENTION_SEMANTIC_CONFLICT',
      message,
      details,
    });
  }
}
