import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayUnique, IsArray, IsBoolean, IsEnum } from 'class-validator';
import { UpdateAppUserAccessBody } from '@epgs/shared-types';

/**
 * No `departmentScope` field by design (issue #78 scope narrowing - see
 * docs/user-admin-design.md "科室范围收窄"): the service always writes an
 * empty array (all departments), so this DTO simply never exposes the field.
 * main.ts's global ValidationPipe runs with forbidNonWhitelisted: true, so a
 * caller that sends `departmentScope` anyway gets a 400 (not a silent drop) -
 * same as any other unrecognized field across this API.
 */
export class UpdateAccessDto implements UpdateAppUserAccessBody {
  @ApiProperty({
    enum: AppRole,
    isArray: true,
    description: 'Full replacement of the role set (not a merge) - mirrors auth:assign-access semantics.',
  })
  @IsArray()
  @ArrayUnique()
  @IsEnum(AppRole, { each: true })
  roles!: AppRole[];

  @ApiProperty({
    description:
      'Grants unmasked patientName/reportContent/diagnosis/bedNo even for otherwise-masking roles.',
  })
  @IsBoolean()
  patientDetail!: boolean;
}
