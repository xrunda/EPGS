import { AuditAction, AppRole } from '@prisma/client';
import { AuditService } from './audit.service';

describe('AuditService (issue #13)', () => {
  const baseInput = {
    action: AuditAction.EXAM_LIST,
    actorUsername: 'doctor',
    actorRole: AppRole.VIEWER,
    resourceType: 'monitor_record',
    meta: { page: 1, pageSize: 20, masked: true, hadQ: false },
    ip: '127.0.0.1',
    correlationId: 'corr-1',
  };

  it('skips the write when the actor is unknown (no access grant)', async () => {
    const create = jest.fn();
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record({ ...baseInput, actorUsername: null });
    await service.record({ ...baseInput, actorRole: null });
    await service.record({ ...baseInput, actorUsername: null, actorRole: null });

    expect(create).not.toHaveBeenCalled();
  });

  it('writes one row with the LOW-sensitivity meta bag (no patient fields)', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record(baseInput);

    expect(create).toHaveBeenCalledWith({
      data: {
        actorUsername: 'doctor',
        actorRole: AppRole.VIEWER,
        action: AuditAction.EXAM_LIST,
        resourceType: 'monitor_record',
        resourceId: null,
        department: null,
        meta: baseInput.meta,
        ip: '127.0.0.1',
        correlationId: 'corr-1',
      },
    });
    // The stored meta is the LOW-sensitivity bag - no patient-identifying
    // keys may ever reach the row (the log-sanitization spec enforces this
    // statically across the tree; here we pin the service contract).
    const storedMeta = create.mock.calls[0][0].data.meta as Record<string, unknown>;
    for (const key of ['patientName', 'reportContent', 'diagnosis', 'contextSnippet']) {
      expect(storedMeta).not.toHaveProperty(key);
    }
  });

  it('swallows a DB failure (audit is fail-open, never a 500)', async () => {
    const create = jest.fn().mockRejectedValue(new Error('connection reset'));
    const service = new AuditService({ auditLog: { create } } as never);

    await expect(service.record(baseInput)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps rows to AuditLogDto with ISO timestamps', async () => {
    const rows = [
      {
        id: 'audit-1',
        actorUsername: 'doctor',
        actorRole: AppRole.VIEWER,
        action: AuditAction.EXAM_DETAIL,
        resourceType: 'monitor_record',
        resourceId: 'record-1',
        department: '消化内科',
        meta: { masked: true },
        ip: '127.0.0.1',
        correlationId: 'corr-2',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      },
    ];
    const service = new AuditService({
      auditLog: {
        findMany: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(1),
      },
    } as never);

    const result = await service.list({ page: 1, pageSize: 50 });

    expect(result).toEqual({
      items: [
        {
          id: 'audit-1',
          actorUsername: 'doctor',
          actorRole: AppRole.VIEWER,
          action: AuditAction.EXAM_DETAIL,
          resourceType: 'monitor_record',
          resourceId: 'record-1',
          department: '消化内科',
          meta: { masked: true },
          ip: '127.0.0.1',
          correlationId: 'corr-2',
          createdAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });
  });
});
