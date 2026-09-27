import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AttentionLevel } from '@prisma/client';
import {
  ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH,
  ATTENTION_SEMANTIC_NAME_MAX_LENGTH,
  CreateAttentionSemanticBody,
} from '@epgs/shared-types';

/**
 * Body for `POST /api/attention-semantics` (issue #88).
 *
 * The length bounds come from @epgs/shared-types so the UI's character counter
 * and this validation cannot disagree. The description is not merely cosmetic:
 * it is the text the classifier matches a report against, which is why it is
 * required and non-blank rather than optional like a rule's `notes`.
 */
export class CreateAttentionSemanticDto implements CreateAttentionSemanticBody {
  @ApiProperty({
    example: '明确或高度疑似恶性病变',
    maxLength: ATTENTION_SEMANTIC_NAME_MAX_LENGTH,
    description: '医生给这条关注语义起的短名称，用于列表和报告详情展示。',
  })
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(ATTENTION_SEMANTIC_NAME_MAX_LENGTH, {
    message: `name must be at most ${ATTENTION_SEMANTIC_NAME_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    example: '报告描述了提示恶性或高度可疑恶性的表现，例如不规则隆起、边缘堤状、质脆易出血……',
    maxLength: ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH,
    description:
      '用医生自己的话说明这条语义要关注什么情况。AI 判读时读的就是这段文字，请描述报告里会出现什么含义，而不是只给一个结论。',
  })
  @IsString()
  @IsNotEmpty({ message: 'description must not be blank' })
  @MaxLength(ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH, {
    message: `description must be at most ${ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  description!: string;

  @ApiProperty({
    enum: AttentionLevel,
    example: 'RED',
    description:
      '这条语义的关注等级。这是管理上的关注等级（需要多快看到），不是诊断结论，也不是病情严重程度。',
  })
  @IsEnum(AttentionLevel, { message: 'attentionLevel must be one of RED, YELLOW, GREEN' })
  attentionLevel!: AttentionLevel;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({
    example: 'zhang.san',
    description:
      'Opaque actor identity. Deprecated since issue #13: the server uses the authenticated username and ignores this value (kept for DTO compatibility).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId!: string;
}
