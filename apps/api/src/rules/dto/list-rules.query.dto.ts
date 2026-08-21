import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MonitorLevel } from '@prisma/client';

function parseOptionalBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class ListRulesQueryDto {
  @ApiPropertyOptional({ description: 'Substring filter on keyword (case-insensitive).' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: MonitorLevel })
  @IsOptional()
  @IsEnum(MonitorLevel, { message: 'level must be one of RED, YELLOW, GREEN, UNCLASSIFIED' })
  level?: MonitorLevel;

  @ApiPropertyOptional({ description: 'Filter by enabled/disabled status.' })
  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Filter by free-text category label.' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;
}
