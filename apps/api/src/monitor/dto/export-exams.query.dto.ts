import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, Matches } from 'class-validator';
import { MonitorLevel } from '@prisma/client';

/**
 * Query for `GET /api/monitor/export` (issue #139): ONE Shanghai calendar day
 * and ONE attention level.
 *
 * Deliberately NOT a reuse of MonitorFiltersDto, for two separate reasons:
 *
 *  1. it cannot be made stricter by inheritance - class-validator reads
 *     inherited metadata, and `@IsOptional()` on the parent's examDateFrom /
 *     examDateTo short-circuits every validator on those properties, so a
 *     subclass cannot turn them into required ones;
 *  2. reusing the eight-filter surface would leave "one day, one level" as a
 *     frontend rule only. AGENTS.md §2.3 puts the business judgement on the
 *     server, and a hand-crafted URL must not be able to ask for a 30-day
 *     all-level dump.
 *
 * Both fields are required and there are no others. `main.ts` runs the global
 * ValidationPipe with `forbidNonWhitelisted`, so `?examDateFrom=`, `?page=1` or
 * any other leftover workbench parameter is a 400 rather than a silently
 * ignored filter. The caller's department scope is applied server-side and is
 * deliberately not a parameter here - a filter the modal does not show would
 * make the file disagree with the two choices the operator made.
 */
export class ExportExamsQueryDto {
  @ApiProperty({
    description:
      'The single Asia/Shanghai calendar day to export, YYYY-MM-DD. Both bounds are this one value - the exclusive upper bound is resolved to the start of the NEXT Shanghai day internally, so this is exactly one day.',
    example: '2026-08-20',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'examDate must be a YYYY-MM-DD date' })
  examDate!: string;

  @ApiProperty({
    enum: MonitorLevel,
    description: 'The single attention level (label colour) to export.',
    example: 'RED',
  })
  @IsEnum(MonitorLevel, { message: 'level must be one of RED, YELLOW, GREEN, UNCLASSIFIED' })
  level!: MonitorLevel;
}
