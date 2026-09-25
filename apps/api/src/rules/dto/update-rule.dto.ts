import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { MonitorLevel, MatchField, MatchMode } from '@prisma/client';
import { SEMANTIC_INTENT_MAX_LENGTH, UpdateMonitorRuleBody } from '@epgs/shared-types';

export class UpdateRuleDto implements UpdateMonitorRuleBody {
  @ApiPropertyOptional({ example: '肿瘤' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'keyword must not be blank' })
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  keyword?: string;

  @ApiPropertyOptional({ enum: MonitorLevel })
  @IsOptional()
  @IsEnum(MonitorLevel, { message: 'level must be one of RED, YELLOW, GREEN, UNCLASSIFIED' })
  level?: MonitorLevel;

  @ApiPropertyOptional({ enum: MatchField })
  @IsOptional()
  @IsEnum(MatchField, {
    message:
      'matchField must be one of FINDINGS, IMPRESSION, REPORT_TEXT, STUDY_DESCRIPTION, OTHER',
  })
  matchField?: MatchField;

  @ApiPropertyOptional({ enum: MatchMode })
  @IsOptional()
  @IsEnum(MatchMode, { message: 'matchMode must be one of EXACT, CONTAINS, REGEX' })
  matchMode?: MatchMode;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: SEMANTIC_INTENT_MAX_LENGTH,
    description:
      'Issue #87: 这个关键词想关注什么情况。省略 = 不修改；null 或空白 = 清空（清空后该规则不再做语义判断）。修改它会生成新版本规则。',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEMANTIC_INTENT_MAX_LENGTH, {
    message: `semanticIntent must be at most ${SEMANTIC_INTENT_MAX_LENGTH} characters`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  semanticIntent?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({
    example: 3,
    description:
      'Optimistic-lock token: must equal the row current version, otherwise a 409 RULE_VERSION_CONFLICT is returned.',
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
