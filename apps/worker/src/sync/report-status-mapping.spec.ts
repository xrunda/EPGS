import { PacsReportStatus } from '@epgs/shared-types';
import { ReportStatus } from '@prisma/client';
import { mapToRecordReportStatus, isReviewed } from './report-status-mapping';

describe('mapToRecordReportStatus', () => {
  it('maps FINAL_REVIEWED to FINAL', () => {
    expect(mapToRecordReportStatus(PacsReportStatus.FINAL_REVIEWED)).toBe(ReportStatus.FINAL);
  });

  it.each([PacsReportStatus.REVIEWED, PacsReportStatus.PENDING_REVIEW, PacsReportStatus.DRAFT])(
    'maps %s to PRELIMINARY',
    (status) => {
      expect(mapToRecordReportStatus(status)).toBe(ReportStatus.PRELIMINARY);
    },
  );

  it.each([PacsReportStatus.EXAM_IN_PROGRESS, PacsReportStatus.AWAITING_REPORT, PacsReportStatus.UNKNOWN])(
    'maps %s to UNKNOWN (never guesses FINAL/PRELIMINARY)',
    (status) => {
      expect(mapToRecordReportStatus(status)).toBe(ReportStatus.UNKNOWN);
    },
  );

  it('never produces AMENDED (no source signal exists for it today)', () => {
    const allStatuses = Object.values(PacsReportStatus);
    for (const status of allStatuses) {
      expect(mapToRecordReportStatus(status)).not.toBe(ReportStatus.AMENDED);
    }
  });
});

describe('isReviewed', () => {
  it('is true only for FINAL_REVIEWED and REVIEWED', () => {
    expect(isReviewed(PacsReportStatus.FINAL_REVIEWED)).toBe(true);
    expect(isReviewed(PacsReportStatus.REVIEWED)).toBe(true);
  });

  it.each([
    PacsReportStatus.EXAM_IN_PROGRESS,
    PacsReportStatus.AWAITING_REPORT,
    PacsReportStatus.DRAFT,
    PacsReportStatus.PENDING_REVIEW,
    PacsReportStatus.UNKNOWN,
  ])('is false for %s', (status) => {
    expect(isReviewed(status)).toBe(false);
  });
});
