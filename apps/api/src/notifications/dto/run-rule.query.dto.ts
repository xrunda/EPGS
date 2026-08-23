import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * POST /api/notification-rules/{id}/run query params.
 *
 * `windowDate` defaults to today (Asia/Shanghai). It exists so an operator can
 * re-push a PAST day's summary after a network outage or config fix; an
 * impossible calendar date slips past the format check and is recorded as a
 * FAILED run by the executor (visible in the push log), never a 500.
 */
export class RunRuleQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-23',
    description: 'Shanghai YYYY-MM-DD summary window to push; defaults to today (Asia/Shanghai).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'windowDate must be a YYYY-MM-DD date' })
  windowDate?: string;
}
