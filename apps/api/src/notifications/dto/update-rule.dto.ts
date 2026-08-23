import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { UpdateNotificationRuleBody } from '@epgs/shared-types';
import { IsValidCron } from './is-valid-cron.decorator';

/**
 * PUT /api/notification-rules/{id} body. All fields optional; when
 * `channelIds` is present it REPLACES the whole binding set.
 */
export class UpdateRuleDto implements UpdateNotificationRuleBody {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    example: '0 9 * * *',
    description: '5-field cron expression (minute hour day month day-of-week), evaluated in Asia/Shanghai.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'cron must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsValidCron({ message: 'cron must be a valid 5-field cron expression' })
  cron?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    description: 'When present, replaces the whole channel binding set (at least one required).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'channelIds must contain at least one channel' })
  @ArrayUnique()
  @IsUUID('4', { each: true })
  channelIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Opaque actor identity. Deprecated since issue #13: the server uses the authenticated username and ignores this value (kept for DTO compatibility).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId?: string;
}
