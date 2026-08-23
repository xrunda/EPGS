import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
import { CreateNotificationRuleBody } from '@epgs/shared-types';
import { IsValidCron } from './is-valid-cron.decorator';

/** POST /api/notification-rules body. */
export class CreateRuleDto implements CreateNotificationRuleBody {
  @ApiProperty({ example: '每日 9 点推送到总值班室群', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    example: '0 9 * * *',
    description: '5-field cron expression (minute hour day month day-of-week), evaluated in Asia/Shanghai.',
  })
  @IsString()
  @IsNotEmpty({ message: 'cron must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsValidCron({ message: 'cron must be a valid 5-field cron expression' })
  cron!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  templateId!: string;

  @ApiProperty({
    type: [String],
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    minItems: 1,
    description: 'At least one channel is required; the rule pushes to every selected channel.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'channelIds must contain at least one channel' })
  @ArrayUnique()
  @IsUUID('4', { each: true })
  channelIds!: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    example: 'zhang.san',
    description:
      'Opaque actor identity. Deprecated since issue #13: the server uses the authenticated username and ignores this value (kept for DTO compatibility).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId?: string;
}
