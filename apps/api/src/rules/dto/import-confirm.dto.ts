import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ImportConfirmBody } from '@epgs/shared-types';

export class ImportConfirmDto implements ImportConfirmBody {
  @ApiProperty({ description: 'Token returned by POST /api/rules/import/validate identifying the validated batch.' })
  @IsString()
  @IsNotEmpty()
  importToken!: string;

  @ApiProperty({ example: 'zhang.san', description: 'Opaque operator identity. Placeholder until issue #13 ships real auth.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  actorId!: string;
}
