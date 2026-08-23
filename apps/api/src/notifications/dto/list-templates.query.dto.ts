import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { NotificationMsgType } from '@prisma/client';

function parseOptionalBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** GET /api/notification-templates query params. */
export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ enum: NotificationMsgType })
  @IsOptional()
  @IsEnum(NotificationMsgType, { message: 'msgType must be one of TEXT, NEWS' })
  msgType?: NotificationMsgType;

  @ApiPropertyOptional({ description: 'Filter by enabled/disabled status.' })
  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  isEnabled?: boolean;

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
