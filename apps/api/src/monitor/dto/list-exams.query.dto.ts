import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MonitorFiltersDto } from './monitor-filters.query.dto';
import { ExamsSortBy, ExamsSortDir } from '@epgs/shared-types';

/** Whitelist of sortable columns for `GET /api/monitor/exams`. */
export const EXAM_SORT_FIELDS = [
  'examTime',
  'currentLevel',
  'patientName',
  'firstMatchedAt',
  'lastMatchedAt',
] as const;
export type ExamSortField = (typeof EXAM_SORT_FIELDS)[number];

export const EXAM_SORT_DIRS = ['asc', 'desc'] as const;

export class ListExamsQueryDto extends MonitorFiltersDto {
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

  @ApiPropertyOptional({
    enum: EXAM_SORT_FIELDS,
    default: 'examTime',
    description:
      'Sort column. Default is examTime (with the RED>YELLOW>GREEN>UNCLASSIFIED tie-break); custom columns sort nulls per Postgres defaults.',
  })
  @IsOptional()
  @IsIn(EXAM_SORT_FIELDS, {
    message:
      'sortBy must be one of examTime, currentLevel, patientName, firstMatchedAt, lastMatchedAt',
  })
  sortBy?: ExamsSortBy = 'examTime';

  @ApiPropertyOptional({ enum: EXAM_SORT_DIRS, default: 'desc' })
  @IsOptional()
  @IsIn(EXAM_SORT_DIRS, { message: 'sortDir must be asc or desc' })
  sortDir?: ExamsSortDir = 'desc';
}
