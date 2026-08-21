import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ImportConfirmBody } from '@epgs/shared-types';

export class ImportConfirmDto implements ImportConfirmBody {
  @ApiProperty({
    description:
      'Token returned by POST /api/rules/import/validate identifying the validated batch.',
  })
  @IsString()
  @IsNotEmpty()
  importToken!: string;

  @ApiProperty({
    example: 'zhang.san',
    description:
      'Deprecated since issue #13: the authenticated username is authoritative; kept for DTO compatibility.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId!: string;
}
