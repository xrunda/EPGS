import { createHash } from 'node:crypto';
import { LEVEL_CONFLICT_DEFAULT_DAYS } from '@epgs/shared-types';
import { LevelConflictsService } from './level-conflicts.service';

/**
 * Unit tests against a mocked PrismaService - no real database. The aggregate is
 * exercised end-to-end through the real `findRecordLevelConflicts` (mocked rows
 * in, DTOs out) rather than by stubbing the conflicts, because the thing most
 * worth guarding here is that the admin's list and the doctor's drawer agree
 * about what a conflict IS; a stubbed rule would not notice the two drifting.
 *
 * apps/api/test/level-conflicts.e2e-spec.ts covers the same surface against a
 * real Postgres instance.
 */

const REPORT_BODY = '胃体见巨大不规则隆起，表面糜烂，质脆。'; // char 8..10 = '隆起'
const RULE_GROUP = '11111111-1111-4111-8111-111111111111';
const OTHER_RULE_GROUP = '33333333-3333-4333-8333-333333333333';
const SEMANTIC_GROUP = '22222222-2222-4222-8222-222222222222';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('LevelConflictsService', () => {
  let prisma: any;
  let service: LevelConflictsService;

  beforeEach(() => {
    prisma = {
      monitorRecord: { findMany: jest.fn(async () => []) },
      monitorLevelConflictRead: {
        findMany: jest.fn(async () => []),
        upsert: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    service = new LevelConflictsService(prisma);
  });

  /** One record with a YELLOW keyword hit under a RED AI finding, same text. */
  function makeRecord(overrides: Record<string, unknown> = {}): any {
    return {
      id: '00000000-0000-0000-0000-000000000001',
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '12-1',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: new Date('2026-09-20T01:00:00Z'),
      lastMatchedAt: new Date('2026-09-26T02:00:00Z'),
      currentLevel: 'RED',
      aiAttentionLevel: 'RED',
      reportVersion: 1,
      aiResolvedAt: new Date('2026-09-26T02:00:05Z'),
      reportContent: REPORT_BODY,
      diagnosis: null,
      matches: [
        {
          ruleId: '00000000-0000-0000-0000-0000000000aa',
          rule: { version: 1, ruleGroupId: RULE_GROUP },
          keyword: '隆起',
          level: 'YELLOW',
          matchedField: 'FINDINGS',
          matchStart: 8,
          matchEnd: 10,
          contextSnippet: '…隆起…',
          matchedAt: new Date('2026-09-26T02:00:01Z'),
          semanticFiltered: false,
          semanticJudgements: [],
        },
      ],
      reportAiAttempts: [
        {
          reportVersion: 1,
          createdAt: new Date('2026-09-26T02:00:05Z'),
          matches: [
            {
              semanticId: '00000000-0000-0000-0000-0000000000bb',
              semanticVersion: 3,
              semanticName: '性质待定、需活检或短期复查的病变',
              attentionLevel: 'RED',
              confidence: 'HIGH',
              reason: '报告描述了不规则隆起。',
              ordinal: 0,
              semantic: { semanticGroupId: SEMANTIC_GROUP },
              evidence: [
                {
                  ordinal: 0,
                  field: 'FINDINGS',
                  evidenceHash: sha256Hex(REPORT_BODY),
                  evidenceStart: 0,
                  evidenceEnd: REPORT_BODY.length,
                },
              ],
            },
          ],
        },
      ],
      _count: { reportAiAttempts: 0 },
      ...overrides,
    };
  }

  const expectedKey = [
    RULE_GROUP,
    SEMANTIC_GROUP,
    'FINDINGS',
    'YELLOW',
    'RED',
  ].join(':');

  describe('list', () => {
    it('aggregates the records into one todo, with the count and the latest sighting', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([
        makeRecord(),
        makeRecord({ lastMatchedAt: new Date('2026-09-25T02:00:00Z') }),
      ]);

      const result = await service.list({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        conflictKey: expectedKey,
        keyword: '隆起',
        keywordLevel: 'YELLOW',
        semanticName: '性质待定、需活检或短期复查的病变',
        semanticLevel: 'RED',
        field: 'FINDINGS',
        recordCount: 2,
        lastSeenAt: '2026-09-26T02:00:00.000Z',
        readAt: null,
      });
      expect(result.unreadCount).toBe(1);
    });

    it('defaults the window and echoes it back', async () => {
      await service.list({});

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            lastMatchedAt: { gte: expect.any(Date) },
          }),
        }),
      );
      await expect(service.list({})).resolves.toMatchObject({
        days: LEVEL_CONFLICT_DEFAULT_DAYS,
        items: [],
      });
    });

    it('narrows the window to the requested number of days', async () => {
      const before = Date.now() - 7 * 24 * 60 * 60 * 1000;
      await service.list({ days: 7 });
      const after = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const since = prisma.monitorRecord.findMany.mock.calls[0][0].where.lastMatchedAt.gte as Date;
      expect(since.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(since.getTime()).toBeLessThanOrEqual(after + 1000);
    });

    it('pre-filters to records that could hold a conflict, without restating the rule', async () => {
      // A record filter, not a SQL join expressing the offsets test: which hit
      // pairs with which finding stays in level-conflict.ts, and this must not
      // become a second implementation of it.
      await service.list({});

      const where = prisma.monitorRecord.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        lastMatchedAt: { gte: expect.any(Date) },
        aiAttentionLevel: { not: null },
        matches: { some: { semanticFiltered: false } },
        reportAiAttempts: { some: { outcome: 'OK' } },
      });
    });

    it('reads exactly the rows the doctor drawer reads', async () => {
      await service.list({});
      const { MonitorService } = await import('../monitor/monitor.service');

      expect(prisma.monitorRecord.findMany.mock.calls[0][0].include).toBe(
        MonitorService.DETAIL_INCLUDE,
      );
    });

    it('reports nothing for a record with no AI contribution to the level', async () => {
      // The same gate toAiSemantics applies: no second side, no disagreement.
      prisma.monitorRecord.findMany.mockResolvedValue([makeRecord({ aiAttentionLevel: null })]);

      await expect(service.list({})).resolves.toMatchObject({ items: [], unreadCount: 0 });
    });

    it('reports nothing for a hit the AI already ruled out', async () => {
      // #87's story, told on the hit row itself - not a second opinion.
      prisma.monitorRecord.findMany.mockResolvedValue([
        makeRecord({
          matches: [{ ...makeRecord().matches[0], semanticFiltered: true }],
        }),
      ]);

      await expect(service.list({})).resolves.toMatchObject({ items: [] });
    });

    it('surfaces a conflict in the diagnosis as its own todo', async () => {
      const diagnosis = '胃体占位，性质待定。';
      prisma.monitorRecord.findMany.mockResolvedValue([
        makeRecord({
          reportContent: null,
          diagnosis,
          matches: [
            {
              ...makeRecord().matches[0],
              matchedField: 'IMPRESSION',
              matchStart: 9,
              matchEnd: 11,
            },
          ],
          reportAiAttempts: [
            {
              ...makeRecord().reportAiAttempts[0],
              matches: [
                {
                  ...makeRecord().reportAiAttempts[0].matches[0],
                  evidence: [
                    {
                      ordinal: 0,
                      field: 'IMPRESSION',
                      evidenceHash: sha256Hex(diagnosis),
                      evidenceStart: 0,
                      evidenceEnd: diagnosis.length,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ]);

      const result = await service.list({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].field).toBe('IMPRESSION');
    });

    it('keeps two rules apart even though they read identically to a doctor', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([
        makeRecord(),
        makeRecord({
          matches: [
            { ...makeRecord().matches[0], rule: { version: 2, ruleGroupId: OTHER_RULE_GROUP } },
          ],
        }),
      ]);

      const result = await service.list({});

      expect(result.items).toHaveLength(2);
      expect(result.items.map((item) => item.recordCount)).toEqual([1, 1]);
    });

    it('filters by read state after aggregating, so the count is not affected', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([makeRecord()]);
      prisma.monitorLevelConflictRead.findMany.mockResolvedValue([
        { conflictKey: expectedKey, readAt: new Date('2026-09-26T03:00:00Z') },
      ]);

      const unreadOnly = await service.list({ read: false });
      const readOnly = await service.list({ read: true });

      expect(unreadOnly).toMatchObject({ items: [], unreadCount: 0 });
      expect(readOnly.items).toHaveLength(1);
      expect(readOnly.items[0].readAt).toBe('2026-09-26T03:00:00.000Z');
      // A read entry is still counted as read even when filtered out.
      expect(readOnly.unreadCount).toBe(0);
    });

    it('treats a kept-but-unread row as unread', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([makeRecord()]);
      prisma.monitorLevelConflictRead.findMany.mockResolvedValue([
        { conflictKey: expectedKey, readAt: null },
      ]);

      const result = await service.list({ read: false });

      expect(result.items).toHaveLength(1);
      expect(result.unreadCount).toBe(1);
    });
  });

  describe('markRead', () => {
    it('upserts the read state and returns it', async () => {
      const readAt = new Date('2026-09-27T02:00:00Z');
      prisma.monitorLevelConflictRead.upsert.mockResolvedValue({ conflictKey: expectedKey, readAt });

      const result = await service.markRead(expectedKey, 'admin');

      expect(prisma.monitorLevelConflictRead.upsert).toHaveBeenCalledWith({
        where: { conflictKey: expectedKey },
        create: {
          conflictKey: expectedKey,
          ruleGroupId: RULE_GROUP,
          semanticGroupId: SEMANTIC_GROUP,
          field: 'FINDINGS',
          keywordLevel: 'YELLOW',
          aiLevel: 'RED',
          readAt: expect.any(Date),
          readBy: 'admin',
        },
        update: { readAt: expect.any(Date), readBy: 'admin' },
        select: { conflictKey: true, readAt: true },
      });
      expect(result).toEqual({ conflictKey: expectedKey, readAt: readAt.toISOString() });
    });

    it('is idempotent: marking an already-read conflict only moves the timestamp', async () => {
      const first = new Date('2026-09-27T02:00:00Z');
      const second = new Date('2026-09-27T03:00:00Z');
      prisma.monitorLevelConflictRead.upsert
        .mockResolvedValueOnce({ conflictKey: expectedKey, readAt: first })
        .mockResolvedValueOnce({ conflictKey: expectedKey, readAt: second });

      expect(await service.markRead(expectedKey, 'admin')).toEqual({
        conflictKey: expectedKey,
        readAt: first.toISOString(),
      });
      expect(await service.markRead(expectedKey, 'admin')).toEqual({
        conflictKey: expectedKey,
        readAt: second.toISOString(),
      });
      // Both calls are the same upsert - there is no read-then-write window for a
      // second admin to slip through.
      expect(prisma.monitorLevelConflictRead.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { conflictKey: expectedKey } }),
      );
    });
  });

  describe('markUnread', () => {
    it('clears the terminal timestamp and keeps the row', async () => {
      const result = await service.markUnread(expectedKey, 'admin');

      expect(prisma.monitorLevelConflictRead.updateMany).toHaveBeenCalledWith({
        where: { conflictKey: expectedKey },
        data: { readAt: null, readBy: 'admin' },
      });
      expect(result).toEqual({ conflictKey: expectedKey, readAt: null });
    });

    it('succeeds for a key with no row - the requested state now holds', async () => {
      prisma.monitorLevelConflictRead.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markUnread(expectedKey, 'admin')).resolves.toEqual({
        conflictKey: expectedKey,
        readAt: null,
      });
    });
  });

  describe('key validation', () => {
    const badKeys = [
      ['not-a-key'],
      [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:YELLOW:PURPLE`],
      [`${RULE_GROUP}:${SEMANTIC_GROUP}:EXAM_ITEM:YELLOW:RED`],
    ];

    it.each(badKeys)('rejects %s on write and stores nothing', async (key) => {
      await expect(service.markRead(key, 'admin')).rejects.toMatchObject({
        response: { code: 'LEVEL_CONFLICT_KEY_INVALID' },
      });
      await expect(service.markUnread(key, 'admin')).rejects.toMatchObject({
        response: { code: 'LEVEL_CONFLICT_KEY_INVALID' },
      });
      expect(prisma.monitorLevelConflictRead.upsert).not.toHaveBeenCalled();
      expect(prisma.monitorLevelConflictRead.updateMany).not.toHaveBeenCalled();
    });

    it('does not echo the rejected key back', async () => {
      // The key is a client-supplied path segment; reflecting it into a response
      // body (and from there into logs) is the shape of a reflected-content
      // problem, so the message describes the FORMAT instead.
      await expect(service.markRead('../../etc/passwd', 'admin')).rejects.toMatchObject({
        response: expect.objectContaining({
          message: expect.not.stringContaining('passwd'),
        }),
      });
    });
  });
});
