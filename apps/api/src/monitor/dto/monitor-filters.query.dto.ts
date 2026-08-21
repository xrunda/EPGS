import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { MonitorLevel } from '@prisma/client';

/**
 * Filters shared verbatim by `GET /api/monitor/exams` and
 * `GET /api/monitor/summary` - the summary counts are computed under the
 * SAME filter set as the list, so the two endpoints always agree on a
 * query. See packages/shared-types/src/monitor.ts (MonitorFiltersQuery)
 * for the wire contract and docs/api/monitor-api.md for filter semantics.
 */
export class MonitorFiltersDto {
  @ApiPropertyOptional({
    description:
      'Inclusive lower bound, YYYY-MM-DD, interpreted as the start of that Asia/Shanghai day.',
    example: '2026-08-20',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'examDateFrom must be a YYYY-MM-DD date' })
  examDateFrom?: string;

  @ApiPropertyOptional({
    description:
      'Exclusive upper bound, YYYY-MM-DD, interpreted as the start of the NEXT Asia/Shanghai day (i.e. records on this date itself are excluded).',
    example: '2026-08-20',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'examDateTo must be a YYYY-MM-DD date' })
  examDateTo?: string;

  @ApiPropertyOptional({
    description: 'Department filter (case-insensitive, exact match).',
    example: '消化内科',
  })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({
    description: 'Patient type source code (exact match), e.g. I/O.',
    example: 'I',
  })
  @IsOptional()
  @IsString()
  patientTypeCode?: string;

  @ApiPropertyOptional({ enum: MonitorLevel, description: 'Attention level.' })
  @IsOptional()
  @IsEnum(MonitorLevel, { message: 'level must be one of RED, YELLOW, GREEN, UNCLASSIFIED' })
  level?: MonitorLevel;

  @ApiPropertyOptional({
    description: 'Exam item substring (case-insensitive).',
    example: '电子胃镜',
  })
  @IsOptional()
  @IsString()
  examItem?: string;

  @ApiPropertyOptional({
    description: 'Patient name substring (case-insensitive). Combined with `keyword` via AND.',
  })
  @IsOptional()
  @IsString()
  patientName?: string;

  @ApiPropertyOptional({
    description:
      'Exact matched-rule keyword (from GET /api/rules). Deliberately NOT report body text ' +
      '(avoids unindexed full-text scans). Combined with `patientName` via AND.',
  })
  @IsOptional()
  @IsString()
  keyword?: string;
}
