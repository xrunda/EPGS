import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { UpdateAppUserStatusBody } from '@epgs/shared-types';

export class UpdateUserStatusDto implements UpdateAppUserStatusBody {
  @ApiProperty({ description: 'false disables the account (login -> 403 AUTH_ACCOUNT_DISABLED).' })
  @IsBoolean()
  isActive!: boolean;
}
