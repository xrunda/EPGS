import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when the selected range + levels match more rows than the export will
 * serialise (MONITOR_EXPORT_MAX_ROWS).
 *
 * Still a refusal rather than a truncation: a file that looks complete and is
 * not is worse than an error. Since #157 the caller always has a way to narrow
 * (a shorter date range, or fewer levels), so the message says so - the
 * "contact the administrator" wording of the single-day era was a dead end.
 */
export class MonitorExportTooLargeException extends BadRequestException {
  constructor(maxRows: number) {
    super({
      code: 'MONITOR_EXPORT_TOO_LARGE',
      message: `所选日期范围内记录过多（超过 ${maxRows} 条），导出已取消。请缩短日期范围或减少关注等级后重试。`,
    });
  }
}
