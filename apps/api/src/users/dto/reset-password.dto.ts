import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ResetAppUserPasswordBody } from '@epgs/shared-types';
import { MatchesProperty } from '../../common/validators/matches-property.decorator';

export class ResetPasswordDto implements ResetAppUserPasswordBody {
  @ApiProperty({ description: 'At least 8 characters. Never logged or echoed back.' })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;

  @ApiProperty({ description: 'Must equal `newPassword`.' })
  @IsString()
  @MatchesProperty('newPassword', { message: '两次输入的新密码不一致。' })
  confirmPassword!: string;
}
