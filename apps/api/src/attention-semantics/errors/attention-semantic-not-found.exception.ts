import { NotFoundException } from '@nestjs/common';

/** Thrown when an attention-semantic id resolves to no row (any version, any enabled state). */
export class AttentionSemanticNotFoundException extends NotFoundException {
  constructor(semanticId: string) {
    super({
      code: 'ATTENTION_SEMANTIC_NOT_FOUND',
      message: `Attention semantic ${semanticId} was not found.`,
    });
  }
}
