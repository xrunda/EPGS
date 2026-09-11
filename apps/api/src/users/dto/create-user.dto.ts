import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CreateAppUserBody } from '@epgs/shared-types';
import { MatchesProperty } from '../../common/validators/matches-property.decorator';

export class CreateUserDto implements CreateAppUserBody {
  @ApiProperty({
    example: 'doctor',
    description: 'Login account, lowercased and trimmed server-side (mirrors auth-cli.ts).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'username 只能包含字母、数字、点、下划线、连字符',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  username!: string;

  @ApiProperty({ example: '李晨' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  displayName!: string;

  @ApiProperty({ description: 'At least 8 characters. Never logged or echoed back.' })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @ApiProperty({ description: 'Must equal `password`.' })
  @IsString()
  @MatchesProperty('password', { message: '两次输入的密码不一致。' })
  confirmPassword!: string;
}
