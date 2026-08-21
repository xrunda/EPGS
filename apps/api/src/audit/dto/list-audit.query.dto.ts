import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditAction } from '@prisma/client';

/** Query params for `GET /api/audit` (issue #13, AUDITOR only). */
export class ListAuditQueryDto {
  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction, { message: 'action must be one of the AuditAction enum values' })
  action?: AuditAction;

  @ApiPropertyOptional({
    description: 'Substring filter on the acting username (case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorUsername?: string;

  @ApiPropertyOptional({ description: 'Department context filter (case-insensitive).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}
