import { MonitorService } from './monitor.service';

/**
 * Unit tests against a mocked PrismaService - no real database. These
 * cover the query-building and mapping logic (where/orderBy shape,
 * Shanghai display formatting, keyword dedupe, patientType passthrough,
 * summary aggregation, detail not-found) in isolation;
 * apps/api/test/monitor.e2e-spec.ts covers the same scenarios against a
 * real Postgres instance per issue #7's verification requirements.
 */
describe('MonitorService', () => {
  let prisma: any;
  let service: MonitorService;

  function makeRow(overrides: Record<string, unknown> = {}): any {
    return {
      id: '00000000-0000-0000-0000-000000000001',
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '12-1',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: new Date('2026-08-20T01:30:00Z'),
      currentLevel: 'RED',
      matches: [
        { keyword: '腺癌', matchedAt: new Date('2026-08-20T01:30:01Z') },
        { keyword: '息肉样', matchedAt: new Date('2026-08-20T01:30:02Z') },
        { keyword: '腺癌', matchedAt: new Date('2026-08-20T01:30:03Z') },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    const monitorRecord = {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      groupBy: jest.fn(),
    };
    prisma = {
      monitorRecord,
      $transaction: jest.fn(async (arg: any) => Promise.all(arg)),
    };
    service = new MonitorService(prisma);
  });

  describe('list', () => {
    it('passes an empty where for an empty query and paginates with defaults', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      const result = await service.list({} as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 20 }),
      );
      expect(prisma.monitorRecord.count).toHaveBeenCalledWith({ where: {} });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('uses the default orderBy (examTime desc nulls-last, level asc tie-break, id tie-break)', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await service.list({} as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { examTime: { sort: 'desc', nulls: 'last' } },
            { currentLevel: 'asc' },
            { id: 'asc' },
          ],
        }),
      );
    });

    it('builds the full where from all combined filters', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await service.list({
        examDateFrom: '2026-08-20',
        examDateTo: '2026-08-21',
        department: '消化内科',
        patientTypeCode: 'I',
        level: 'RED',
        examItem: '电子胃镜',
        q: '腺癌',
      } as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            examTime: {
              gte: new Date('2026-08-19T16:00:00Z'), // 2026-08-20T00:00:00+08:00
              lt: new Date('2026-08-21T16:00:00Z'), // 2026-08-22T00:00:00+08:00 (exclusive)
            },
            department: { equals: '消化内科', mode: 'insensitive' },
            patientTypeCode: 'I',
            currentLevel: 'RED',
            examItem: { contains: '电子胃镜', mode: 'insensitive' },
            OR: [
              { patientName: { contains: '腺癌', mode: 'insensitive' } },
              { matches: { some: { keyword: { contains: '腺癌', mode: 'insensitive' } } } },
            ],
          },
        }),
      );
    });

    it('applies page/pageSize to skip/take', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await service.list({ page: 3, pageSize: 10 } as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('maps sortBy=examTime&sortDir=asc to examTime ascending orderBy', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await service.list({ sortBy: 'examTime', sortDir: 'asc' } as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { examTime: { sort: 'asc', nulls: 'last' } },
            { currentLevel: 'asc' },
            { id: 'asc' },
          ],
        }),
      );
    });

    it('maps sortBy=patientName&sortDir=desc to patientName descending orderBy', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await service.list({ sortBy: 'patientName', sortDir: 'desc' } as any);

      expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ patientName: 'desc' }, { id: 'asc' }] }),
      );
    });

    it('rejects an impossible calendar date with INVALID_DATE_PARAM instead of a raw 500', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([]);
      prisma.monitorRecord.count.mockResolvedValue(0);

      await expect(service.list({ examDateFrom: '2026-02-31' } as any)).rejects.toMatchObject({
        response: { code: 'INVALID_DATE_PARAM' },
      });
      expect(prisma.monitorRecord.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list mapping', () => {
    it('maps a list row to the DTO: Shanghai date/time strings, patientType, deduped keywords', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([makeRow()]);
      prisma.monitorRecord.count.mockResolvedValue(1);

      const result = await service.list({} as any);
      const item = result.items[0];

      expect(item.recordId).toBe('00000000-0000-0000-0000-000000000001');
      expect(item.monitorLevel).toBe('RED');
      expect(item.examDate).toBe('2026-08-20'); // UTC 01:30 == Shanghai 09:30
      expect(item.examTime).toBe('09:30:00');
      expect(item.patientType).toEqual({ code: 'I', name: '住院' });
      // Duplicate keyword collapsed; order preserved from earliest matchedAt.
      expect(item.matchedKeywords).toEqual(['腺癌', '息肉样']);
      // The wire type guarantees the report body is absent from list rows.
      expect(item).not.toHaveProperty('reportContent');
      expect(item).not.toHaveProperty('diagnosis');
    });

    it('maps null examTime/patientTypeName to null display values (never guessed)', async () => {
      prisma.monitorRecord.findMany.mockResolvedValue([
        makeRow({ examTime: null, patientTypeCode: 'X', patientTypeName: null }),
      ]);
      prisma.monitorRecord.count.mockResolvedValue(1);

      const result = await service.list({} as any);
      const item = result.items[0];

      expect(item.examDate).toBeNull();
      expect(item.examTime).toBeNull();
      expect(item.patientType).toEqual({ code: 'X', name: null });
      expect(item.matchedKeywords).toEqual(['腺癌', '息肉样']);
    });
  });

  describe('summary', () => {
    it('aggregates groupBy results into the five buckets with total = sum', async () => {
      prisma.monitorRecord.groupBy.mockResolvedValue([
        { currentLevel: 'RED', _count: { _all: 3 } },
        { currentLevel: 'YELLOW', _count: { _all: 4 } },
        { currentLevel: 'GREEN', _count: { _all: 3 } },
        { currentLevel: 'UNCLASSIFIED', _count: { _all: 2 } },
      ]);

      const result = await service.summary({} as any);

      expect(result).toEqual({ total: 12, red: 3, yellow: 4, green: 3, unclassified: 2 });
    });

    it('defaults absent level buckets to 0', async () => {
      prisma.monitorRecord.groupBy.mockResolvedValue([
        { currentLevel: 'RED', _count: { _all: 3 } },
      ]);

      const result = await service.summary({} as any);

      expect(result).toEqual({ total: 3, red: 3, yellow: 0, green: 0, unclassified: 0 });
    });

    it('passes the same where to groupBy as the list would use', async () => {
      prisma.monitorRecord.groupBy.mockResolvedValue([
        { currentLevel: 'RED', _count: { _all: 1 } },
      ]);

      await service.summary({ level: 'RED' } as any);

      expect(prisma.monitorRecord.groupBy).toHaveBeenCalledWith({
        by: ['currentLevel'],
        where: { currentLevel: 'RED' },
        _count: { _all: true },
      });
    });
  });

  describe('getDetail', () => {
    it('returns a full detail DTO when the record exists', async () => {
      prisma.monitorRecord.findUnique.mockResolvedValue({
        ...makeRow(),
        reportContent: '报告正文快照',
        diagnosis: '诊断意见快照',
        matches: [
          {
            ruleId: '00000000-0000-0000-0000-0000000000aa',
            rule: { version: 1 },
            keyword: '腺癌',
            level: 'RED',
            matchedField: 'REPORT_TEXT',
            contextSnippet: '…见腺癌…',
            matchedAt: new Date('2026-08-20T01:30:01Z'),
          },
        ],
      });

      const dto = await service.getDetail('00000000-0000-0000-0000-000000000001');

      // Issue #8: the detail query must pull the versioned rule so each hit
      // is auditable back to the exact rule version that produced it.
      expect(prisma.monitorRecord.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            matches: {
              orderBy: [{ matchedAt: 'asc' }, { id: 'asc' }],
              include: { rule: { select: { version: true } } },
            },
          },
        }),
      );
      expect(dto.reportContent).toBe('报告正文快照');
      expect(dto.diagnosis).toBe('诊断意见快照');
      expect(dto.hits).toHaveLength(1);
      expect(dto.hits[0]).toEqual({
        ruleId: '00000000-0000-0000-0000-0000000000aa',
        ruleVersion: 1,
        keyword: '腺癌',
        level: 'RED',
        matchedField: 'REPORT_TEXT',
        contextSnippet: '…见腺癌…',
        matchedAt: '2026-08-20T01:30:01.000Z',
      });
      expect(dto.matchedKeywords).toEqual(['腺癌']);
    });

    it('throws MONITOR_RECORD_NOT_FOUND for an unknown id', async () => {
      prisma.monitorRecord.findUnique.mockResolvedValue(null);

      await expect(service.getDetail('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject(
        {
          response: { code: 'MONITOR_RECORD_NOT_FOUND' },
        },
      );
    });
  });
});
