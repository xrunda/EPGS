import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { AttentionLevel } from '@prisma/client';
import {
  ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH,
  ATTENTION_SEMANTIC_NAME_MAX_LENGTH,
  UpdateAttentionSemanticBody,
} from '@epgs/shared-types';

/**
 * Body for `PUT /api/attention-semantics/{id}` (issue #88).
 *
 * Changing name/description/attentionLevel creates a NEW versioned row and
 * disables the old one; changing only isEnabled edits in place. The reason is
 * the same as MonitorRule's: an AI match must stay traceable to the exact
 * wording that was in force when it judged a report. Editing the description in
 * place would rewrite, retroactively, what past findings appear to have been
 * based on.
 */
export class UpdateAttentionSemanticDto implements UpdateAttentionSemanticBody {
  @ApiPropertyOptional({ maxLength: ATTENTION_SEMANTIC_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(ATTENTION_SEMANTIC_NAME_MAX_LENGTH, {
    message: `name must be at most ${ATTENTION_SEMANTIC_NAME_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    maxLength: ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH,
    description: '修改它会生成新的语义版本，历史 AI 判定仍指向当时使用的文字。',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'description must not be blank' })
  @MaxLength(ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH, {
    message: `description must be at most ${ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  description?: string;

  @ApiPropertyOptional({ enum: AttentionLevel })
  @IsOptional()
  @IsEnum(AttentionLevel, { message: 'attentionLevel must be one of RED, YELLOW, GREEN' })
  attentionLevel?: AttentionLevel;

  @ApiPropertyOptional({ description: '启用/停用。修改它不会生成新版本。' })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({
    example: 1,
    description:
      'Optimistic-lock token: must equal the row current version, otherwise a 409 ATTENTION_SEMANTIC_VERSION_CONFLICT is returned.',
  })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({
    example: 'zhang.san',
    description:
      'Deprecated since issue #13: the authenticated username is authoritative; kept for DTO compatibility.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId!: string;
}
