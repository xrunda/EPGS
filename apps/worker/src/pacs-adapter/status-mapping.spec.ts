import { PacsReportStatus } from '@epgs/shared-types';
import { mapRawStatus } from './status-mapping';

describe('mapRawStatus', () => {
  it.each([
    ['IN_PROGRESS', PacsReportStatus.EXAM_IN_PROGRESS],
    ['AWAITING_REPORT', PacsReportStatus.AWAITING_REPORT],
    ['DRAFT', PacsReportStatus.DRAFT],
    ['SUBMITTED', PacsReportStatus.PENDING_REVIEW],
    ['REVIEWED', PacsReportStatus.REVIEWED],
    ['FINAL', PacsReportStatus.FINAL_REVIEWED],
    ['AUDITED', PacsReportStatus.FINAL_REVIEWED],
  ])('maps known raw status %s to %s', (raw, expected) => {
    expect(mapRawStatus(raw)).toBe(expected);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(mapRawStatus('  final  ')).toBe(PacsReportStatus.FINAL_REVIEWED);
    expect(mapRawStatus('Audited')).toBe(PacsReportStatus.FINAL_REVIEWED);
  });

  it('maps unrecognized codes to UNKNOWN, never to a reviewed state', () => {
    expect(mapRawStatus('VENDOR_CODE_99_UNDOCUMENTED')).toBe(PacsReportStatus.UNKNOWN);
    expect(mapRawStatus('totally-made-up')).toBe(PacsReportStatus.UNKNOWN);
  });

  it('maps null/undefined/empty to UNKNOWN', () => {
    expect(mapRawStatus(null)).toBe(PacsReportStatus.UNKNOWN);
    expect(mapRawStatus(undefined)).toBe(PacsReportStatus.UNKNOWN);
    expect(mapRawStatus('')).toBe(PacsReportStatus.UNKNOWN);
    expect(mapRawStatus('   ')).toBe(PacsReportStatus.UNKNOWN);
  });

  it('never returns FINAL_REVIEWED for an unmapped code (regression guard)', () => {
    const unmapped = ['XYZ', 'STATUS_42', 'unset', 'null', 'none'];
    for (const code of unmapped) {
      expect(mapRawStatus(code)).not.toBe(PacsReportStatus.FINAL_REVIEWED);
      expect(mapRawStatus(code)).not.toBe(PacsReportStatus.REVIEWED);
      expect(mapRawStatus(code)).toBe(PacsReportStatus.UNKNOWN);
    }
  });
});
