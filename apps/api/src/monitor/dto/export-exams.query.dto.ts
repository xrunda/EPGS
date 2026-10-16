import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, Matches } from 'class-validator';
import { MonitorLevel } from '@prisma/client';
import { orderExportLevels } from '../monitor-csv';

/**
 * Query for `GET /api/monitor/export` (issue #139, multi-level since #145):
 * ONE Shanghai calendar day and one or more attention levels.
 *
 * Deliberately NOT a reuse of MonitorFiltersDto, for two separate reasons:
 *
 *  1. it cannot be made stricter by inheritance - class-validator reads
 *     inherited metadata, and `@IsOptional()` on the parent's examDateFrom /
 *     examDateTo short-circuits every validator on those properties, so a
 *     subclass cannot turn them into required ones;
 *  2. reusing the eight-filter surface would leave "one day, which levels" as a
 *     frontend rule only. AGENTS.md §2.3 puts the business judgement on the
 *     server, and a hand-crafted URL must not be able to ask for a 30-day dump.
 *
 * Both fields are required and there are no others. `main.ts` runs the global
 * ValidationPipe with `forbidNonWhitelisted`, so `?examDateFrom=`, `?page=1` or
 * any other leftover workbench parameter is a 400 rather than a silently
 * ignored filter - and so is the pre-#145 `?level=RED`, deliberately: keeping
 * the old single-value name as an alias would leave the single-level contract
 * in the API forever. The caller's department scope is applied server-side and
 * is deliberately not a parameter here - a filter the modal does not show would
 * make the file disagree with the choices the operator made.
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
    isArray: true,
    description:
      'One or more attention levels (label colours) to export, comma-separated in a single parameter, e.g. levels=RED,YELLOW. De-duplicated and put into the red-to-unclassified order the rest of the system uses, so a given selection always produces the same file name.',
    example: 'RED,YELLOW',
  })
  @Transform(parseLevels)
  @IsArray({ message: 'levels must be a comma-separated list, e.g. levels=RED,YELLOW' })
  @ArrayNotEmpty({ message: 'levels must name at least one attention level' })
  @IsEnum(MonitorLevel, {
    each: true,
    message: 'levels must be a comma-separated list of RED, YELLOW, GREEN, UNCLASSIFIED',
  })
  levels!: MonitorLevel[];
}

/**
 * `?levels=RED,YELLOW` (or a repeated `?levels=RED&levels=YELLOW`, which Nest
 * hands over as an array) -> the canonical, de-duplicated level list.
 *
 * WHY THIS READS `obj` AND NOT `value`. The global ValidationPipe runs with
 * `enableImplicitConversion: true`, and implicit conversion happens BEFORE a
 * custom transform sees the value - so by the time this is called, a single
 * `?levels=RED,YELLOW` has already been coerced toward the property's `Array`
 * type (`['RED,YELLOW']`), and the comma inside the string is invisible.
 * `list-level-conflicts.query.dto.spec.ts` documents the same trap for
 * `?read=false`. The raw value from the source object is the only trustworthy
 * one, and the accompanying spec runs this through a real ValidationPipe rather
 * than calling the function directly.
 *
 * Splitting is lenient about whitespace and empties (`RED, YELLOW,` is two
 * levels), strict about everything else: an empty result reaches
 * `@ArrayNotEmpty` and an unrecognised name reaches `@IsEnum`, so both are a
 * 400 rather than a quietly narrower export. Duplicates collapse - "RED,RED" is
 * one level, not an error - and the order is normalised by `orderExportLevels`.
 */
export function parseLevels({ value, obj, key }: TransformFnParams): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key] ?? value;
  if (raw === undefined || raw === null) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return orderExportLevels(parts);
}
