import { StreamableFile } from '@nestjs/common';
import { AuditAction, AppRole } from '@prisma/client';
import { MonitorController } from './monitor.controller';
import { MonitorExportForbiddenException } from './errors/monitor-export-forbidden.exception';

/**
 * Controller-layer tests for the CSV export (issue #139): the patientDetail
 * gate, the headers, and the audit-trail discipline. Services are mocked, and
 * the class-level @RequireRoles metadata is not exercised here - the security
 * e2e suite covers the real role matrix against real guards.
 */
describe('MonitorController.exportDay', () => {
  const CSV_BODY = Buffer.from('﻿关注等级,患者姓名\r\n红色关注,张三\r\n', 'utf8');

  let monitorService: any;
  let audit: any;
  let controller: MonitorController;
  let response: { setHeader: jest.Mock };

  const request: any = { ip: '10.0.0.9', correlationId: 'corr-139' };
  const query = { examDate: '2026-08-20', level: 'RED' as const };

  function user(overrides: Record<string, unknown> = {}) {
    return {
      username: 'zhang.san',
      roles: [AppRole.VIEWER],
      departmentScope: ['消化内科'],
      patientDetail: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    monitorService = {
      exportDay: jest.fn(async () => ({ rowCount: 2, body: CSV_BODY })),
    };
    audit = { record: jest.fn(async () => undefined) };
    controller = new MonitorController(monitorService, audit);
    response = { setHeader: jest.fn() };
  });

  describe('the patientDetail gate', () => {
    it('refuses a caller without the grant with PATIENT_DETAIL_REQUIRED', async () => {
      const error = await controller
        .exportDay(query as any, user({ patientDetail: false }) as any, request, response as any)
        .then(() => null)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(MonitorExportForbiddenException);
      // Distinct from RolesGuard's FORBIDDEN so the modal can tell the operator
      // which of the two walls they hit.
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'PATIENT_DETAIL_REQUIRED' }),
      );
      expect(error.getStatus()).toBe(403);
    });

    it('refuses an unauthenticated call (no access row -> @CurrentUser() is null)', async () => {
      await expect(
        controller.exportDay(query as any, null, request, response as any),
      ).rejects.toBeInstanceOf(MonitorExportForbiddenException);
    });

    it('reads nothing and records nothing when it refuses', async () => {
      await controller
        .exportDay(query as any, user({ patientDetail: false }) as any, request, response as any)
        .catch(() => undefined);

      expect(monitorService.exportDay).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('the successful file', () => {
    it('passes one day, one level and the caller scope to the service', async () => {
      await controller.exportDay(query as any, user() as any, request, response as any);

      expect(monitorService.exportDay).toHaveBeenCalledWith(
        { examDate: '2026-08-20', level: 'RED' },
        { scope: ['消化内科'] },
      );
    });

    it('returns a text/csv StreamableFile with an RFC 5987 disposition', async () => {
      const file = await controller.exportDay(
        query as any,
        user() as any,
        request,
        response as any,
      );

      expect(file).toBeInstanceOf(StreamableFile);
      expect(file.getHeaders()).toEqual(
        expect.objectContaining({
          type: 'text/csv; charset=utf-8',
          length: CSV_BODY.length,
          disposition: expect.stringContaining('attachment; filename="monitor-2026-08-20-RED.csv"'),
        }),
      );
      // The Chinese name rides in filename*=UTF-8''; the ASCII fallback stays
      // pure ASCII so clients that ignore filename* still get a usable name.
      expect(file.getHeaders().disposition).toContain("filename*=UTF-8''");
      expect(file.getHeaders().disposition).not.toMatch(/filename="[^"]*[^\x20-\x7e][^"]*"/);
    });

    it('sets no-store, nosniff and the row count, and these are the ONLY headers it sets', async () => {
      await controller.exportDay(query as any, user() as any, request, response as any);

      expect(response.setHeader.mock.calls).toEqual([
        ['Cache-Control', 'no-store'],
        ['X-Content-Type-Options', 'nosniff'],
        ['X-Row-Count', '2'],
      ]);
    });

    it('sets the headers only after the audit write, so a failure cannot half-send', async () => {
      const order: string[] = [];
      audit.record.mockImplementation(async () => {
        order.push('audit');
      });
      response.setHeader.mockImplementation((name: string) => {
        order.push(`header:${name}`);
      });

      await controller.exportDay(query as any, user() as any, request, response as any);

      expect(order).toEqual([
        'audit',
        'header:Cache-Control',
        'header:X-Content-Type-Options',
        'header:X-Row-Count',
      ]);
    });
  });

  describe('the audit row', () => {
    it('records EXAM_EXPORT with the filters and the count', async () => {
      await controller.exportDay(query as any, user() as any, request, response as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.EXAM_EXPORT,
          actorUsername: 'zhang.san',
          actorRole: AppRole.VIEWER,
          resourceType: 'monitor_record',
          ip: '10.0.0.9',
          correlationId: 'corr-139',
        }),
      );
      const recorded = audit.record.mock.calls[0][0];
      expect(recorded.meta).toEqual({
        scope: ['消化内科'],
        examDate: '2026-08-20',
        level: 'RED',
        rowCount: 2,
      });
      // The row must be readable without holding patient data, and it must not
      // carry the file: it is the only record that a copy left the system.
      expect(recorded.resourceId).toBeUndefined();
      expect(JSON.stringify(recorded.meta)).not.toContain('张三');
    });

    it('records EXAM_EXPORT and not EXAM_LIST (the export is not a list read)', async () => {
      await controller.exportDay(query as any, user() as any, request, response as any);

      const actions = audit.record.mock.calls.map((call: any[]) => call[0].action);
      expect(actions).toEqual([AuditAction.EXAM_EXPORT]);
    });
  });
});
