import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when one day + one level matches more rows than the export will
 * serialise (MONITOR_EXPORT_MAX_ROWS).
 *
 * This is a CORRUPTION GUARD, not a usable user path: with the filter surface
 * reduced to a single day and a single attention level there is nothing left
 * for the caller to narrow, so a refusal is a dead end. It fires only if the
 * table is in a state the product cannot produce (a botched backfill, a bad
 * sync window), and the alternative - silently truncating - would hand someone
 * a file that looks complete and is not.
 */
export class MonitorExportTooLargeException extends BadRequestException {
  constructor(maxRows: number) {
    super({
      code: 'MONITOR_EXPORT_TOO_LARGE',
      message: `当日该等级记录过多（超过 ${maxRows} 条），导出已取消，请联系管理员。`,
    });
  }
}
