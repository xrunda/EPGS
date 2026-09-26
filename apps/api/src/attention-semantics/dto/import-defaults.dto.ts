import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ImportAttentionSemanticsBody } from '@epgs/shared-types';

/**
 * Body for `POST /api/attention-semantics/import-defaults` (issue #88).
 *
 * This is the ONLY way the preset templates become a hospital's configuration.
 * No migration writes medical semantics (owner decision), so a hospital that
 * never calls this has no AI semantics at all and the classifier reports
 * NO_SEMANTICS rather than judging reports against wording nobody approved.
 */
export class ImportDefaultsDto implements ImportAttentionSemanticsBody {
  @ApiPropertyOptional({
    default: false,
    description:
      '默认 false：已存在的同名语义保持医院自己的名称/说明/等级不变。设为 true 才会用模板内容覆盖（生成新版本）。',
  })
  @IsOptional()
  @IsBoolean()
  overwriteExisting?: boolean;

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
