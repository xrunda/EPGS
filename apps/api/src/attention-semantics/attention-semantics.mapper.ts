import { AttentionSemantic } from '@prisma/client';
import { AttentionSemanticDto } from '@epgs/shared-types';

/** Maps a Prisma AttentionSemantic row to the wire-level DTO (ISO date strings, etc). */
export function toAttentionSemanticDto(semantic: AttentionSemantic): AttentionSemanticDto {
  return {
    id: semantic.id,
    semanticGroupId: semantic.semanticGroupId,
    name: semantic.name,
    description: semantic.description,
    attentionLevel: semantic.attentionLevel,
    isEnabled: semantic.isEnabled,
    version: semantic.version,
    createdAt: semantic.createdAt.toISOString(),
    updatedAt: semantic.updatedAt.toISOString(),
    createdBy: semantic.createdBy,
    updatedBy: semantic.updatedBy,
  };
}
