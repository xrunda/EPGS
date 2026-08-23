import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NotificationMsgType } from '@prisma/client';
import { CreateNotificationTemplateBody } from '@epgs/shared-types';

/**
 * POST /api/notification-templates body.
 *
 * `titleTemplate` is required for msgType = NEWS but forbidden for TEXT.
 * That cross-field rule is enforced in the SERVICE layer (code
 * NOTIFICATION_TEMPLATE_TITLE_REQUIRED) rather than in this DTO: a
 * class-validator approach (@ValidateIf/@IsOptional interplay) makes it
 * impossible to distinguish "field absent" from "field present-but-optional"
 * cleanly, and the update path must merge partial bodies anyway. Here the
 * field is merely string-constrained (see notification-design.md §4).
 *
 * `contentTemplate` may contain {{placeholder}} tokens - the fixed
 * dictionary is documented by GET /api/notification-templates/variables and
 * rendered at send time by NotificationTestSendService.
 */
export class CreateTemplateDto implements CreateNotificationTemplateBody {
  @ApiProperty({ example: '红色预警通知', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ enum: NotificationMsgType, example: 'TEXT' })
  @IsEnum(NotificationMsgType, { message: 'msgType must be one of TEXT, NEWS' })
  msgType!: NotificationMsgType;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Required when msgType = NEWS (service-enforced); must be absent for TEXT.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'titleTemplate must not be blank' })
  @MaxLength(200)
  titleTemplate?: string;

  @ApiProperty({
    example: '{{reportDate}} {{hospitalName}} 红色关注 {{redCount}} 例，请及时处理。',
    description: 'Message body. May contain {{placeholder}} tokens from the variables dictionary.',
  })
  @IsString()
  @IsNotEmpty({ message: 'contentTemplate must not be blank' })
  contentTemplate!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  coverImageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  linkUrl?: string | null;

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
