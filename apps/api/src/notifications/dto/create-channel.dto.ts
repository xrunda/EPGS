import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateNotificationChannelBody } from '@epgs/shared-types';

/**
 * POST /api/notification-channels body.
 *
 * `webhookUrl` is the plaintext WeCom webhook URL. It is encrypted at rest
 * (NotificationSecretCipher, AES-256-GCM) and NEVER returned by any read
 * endpoint - responses only expose the masked preview `webhookUrlMasked`
 * (see notifications.mapper.ts). Do not log it; the controller's audit meta
 * deliberately excludes it.
 */
export class CreateChannelDto implements CreateNotificationChannelBody {
  @ApiProperty({ example: '总值班室群', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    example: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24...',
    maxLength: 2000,
    description: 'Plaintext WeCom webhook URL, encrypted at rest. Never returned by reads.',
  })
  @IsString()
  @IsNotEmpty({ message: 'webhookUrl must not be blank' })
  @MaxLength(2000)
  webhookUrl!: string;

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
