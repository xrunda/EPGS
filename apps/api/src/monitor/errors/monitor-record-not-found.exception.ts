import { NotFoundException } from '@nestjs/common';

/** Thrown when a monitor_record id does not resolve to any record. */
export class MonitorRecordNotFoundException extends NotFoundException {
  constructor(recordId: string) {
    super({
      code: 'MONITOR_RECORD_NOT_FOUND',
      message: `Monitor record ${recordId} was not found.`,
    });
  }
}
