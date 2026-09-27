import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { LEVEL_CONFLICT_DEFAULT_DAYS, LEVEL_CONFLICT_MAX_DAYS } from '@epgs/shared-types';

/**
 * `?x=true` / `?x=false` / `?x=` -> boolean / boolean / undefined.
 *
 * WHY THIS READS `obj` AND NOT `value`. The global ValidationPipe runs with
 * `enableImplicitConversion: true`, and implicit conversion happens BEFORE a
 * custom transform sees the value - so by the time this is called, the query
 * string has already been through `Boolean(...)`, and `?read=false` has become
 * `true`. That is not a subtle near-miss: it is the exact opposite of what the
 * caller asked for, and it is the kind of mistake that looks like it works,
 * because the default (no parameter) path is unaffected.
 *
 * The raw value from the source object is therefore the only trustworthy one.
 * `list-level-conflicts.query.dto.spec.ts` pins this, run through a real
 * ValidationPipe with the production transform options rather than by calling
 * the function directly - the bug lives in the pipeline, not in the function.
 */
export function parseOptionalBoolean({ value, obj, key }: TransformFnParams): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key] ?? value;
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/**
 * Query params for `GET /api/monitor/level-conflicts` (issue #103).
 *
 * `days` is bounded rather than free-form because it is the aggregation's only
 * upper bound: the scan is "records active in the last N days", and the result
 * is computed in JS from those rows. The cap is shared with the client
 * (LEVEL_CONFLICT_MAX_DAYS) so the UI cannot offer a window the server rejects.
 */
export class ListLevelConflictsQueryDto {
  @ApiPropertyOptional({
    default: LEVEL_CONFLICT_DEFAULT_DAYS,
    minimum: 1,
    maximum: LEVEL_CONFLICT_MAX_DAYS,
    description: `Trailing window in days over each record's last activity. 1..${LEVEL_CONFLICT_MAX_DAYS}.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEVEL_CONFLICT_MAX_DAYS)
  days?: number = LEVEL_CONFLICT_DEFAULT_DAYS;

  @ApiPropertyOptional({
    description: 'true = only entries an admin has marked read; false = only unread. Omit for both.',
  })
  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  read?: boolean;
}
