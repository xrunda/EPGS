import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { MatchesProperty } from '../../common/validators/matches-property.decorator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;

  @IsString()
  @MatchesProperty('newPassword', { message: '两次输入的新密码不一致。' })
  confirmPassword!: string;
}
