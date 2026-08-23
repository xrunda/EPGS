import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { UpdateNotificationChannelBody } from '@epgs/shared-types';

/**
 * PUT /api/notification-channels/{id} body. All fields optional.
 *
 * `webhookUrl` is WRITE-ONLY: when present it replaces the stored value
 * (re-encrypted fresh); when absent the existing ciphertext is preserved.
 * The API never echoes the plaintext or the masked preview back as a
 * writable field name (reads expose `webhookUrlMasked`), so a client cannot
 * - and must not - submit a masked value here. The validation is deliberately
 * permissive (whitespace-trimmed non-empty only); the service layer decides
 * what "no webhookUrl" means for a partial update.
 */
export class UpdateChannelDto implements UpdateNotificationChannelBody {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name must not be blank' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Write-only: when present, replaces the stored webhook URL; when absent, keeps the existing ciphertext.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'webhookUrl must not be blank' })
  @MaxLength(2000)
  webhookUrl?: string;

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
