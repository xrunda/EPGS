import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MonitorLevel, MatchField, MatchMode } from '@prisma/client';
import { CreateMonitorRuleBody, SEMANTIC_INTENT_MAX_LENGTH } from '@epgs/shared-types';

/**
 * class-validator/class-transformer is the Nest-standard, minimal-
 * dependency choice (see apps/api's existing ValidationPipe usage
 * convention - health module has no body to validate yet, so this module
 * establishes the pattern per issue #4's implementation notes).
 */
export class CreateRuleDto implements CreateMonitorRuleBody {
  @ApiProperty({
    example: '肿瘤',
    description: 'Keyword or phrase to match. Whitespace-only values are rejected.',
  })
  @IsString()
  @IsNotEmpty({ message: 'keyword must not be blank' })
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  keyword!: string;

  @ApiProperty({ enum: MonitorLevel, example: 'RED' })
  @IsEnum(MonitorLevel, { message: 'level must be one of RED, YELLOW, GREEN, UNCLASSIFIED' })
  level!: MonitorLevel;

  @ApiProperty({
    enum: MatchField,
    example: 'REPORT_TEXT',
    description: 'Which report field this rule is evaluated against.',
  })
  @IsEnum(MatchField, {
    message:
      'matchField must be one of FINDINGS, IMPRESSION, REPORT_TEXT, STUDY_DESCRIPTION, OTHER',
  })
  matchField!: MatchField;

  @ApiPropertyOptional({ enum: MatchMode, example: 'CONTAINS', default: 'CONTAINS' })
  @IsOptional()
  @IsEnum(MatchMode, { message: 'matchMode must be one of EXACT, CONTAINS, REGEX' })
  matchMode?: MatchMode;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'Free-text grouping label (e.g. department/tumor-site), not an FK.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    maxLength: SEMANTIC_INTENT_MAX_LENGTH,
    description:
      'Issue #87: 这个关键词想关注什么情况（自然语言，例如「本次明确或疑似存在的病变；单纯否定和既往史不算」）。留空表示不做语义判断。',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEMANTIC_INTENT_MAX_LENGTH, {
    message: `semanticIntent must be at most ${SEMANTIC_INTENT_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  semanticIntent?: string | null;

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
