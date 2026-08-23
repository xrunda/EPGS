import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { UpdateNotificationTemplateBody } from '@epgs/shared-types';

/**
 * PUT /api/notification-templates/{id} body. All fields optional.
 *
 * The cross-field rule "msgType = NEWS requires titleTemplate" is checked
 * against the MERGED result in the service layer (see CreateTemplateDto's
 * doc comment for why it lives there, and the notification-design.md §4
 * contract). A titleTemplate submitted for a TEXT template is dropped by the
 * service, not rejected here.
 */
export class UpdateTemplateDto implements UpdateNotificationTemplateBody {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ enum: NotificationMsgType })
  @IsOptional()
  @IsEnum(NotificationMsgType, { message: 'msgType must be one of TEXT, NEWS' })
  msgType?: NotificationMsgType;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Required when the merged msgType = NEWS (service-enforced).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'titleTemplate must not be blank' })
  @MaxLength(200)
  titleTemplate?: string;

  @ApiPropertyOptional({ description: 'May contain {{placeholder}} tokens.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'contentTemplate must not be blank' })
  contentTemplate?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  coverImageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  linkUrl?: string | null;

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
