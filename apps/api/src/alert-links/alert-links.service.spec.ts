import { ConfigService } from '@nestjs/config';
import { MonitorExamDto, MonitorExamWorkbenchDetailDto } from '@epgs/shared-types';
import { AlertLinksService } from './alert-links.service';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorService } from '../monitor/monitor.service';
import { MonitorRecordNotFoundException } from '../monitor/errors/monitor-record-not-found.exception';
import { ResolvedAlertLink } from './alert-link.types';

const link: ResolvedAlertLink = {
  id: 'link-1',
  level: 'YELLOW',
  windowDate: '2026-09-05',
  recordIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  createdAt: new Date('2026-09-05T01:00:00Z'),
  expiresAt: new Date('2026-09-06T01:00:00Z'),
};

function makeRow(overrides: Partial<MonitorExamDto> = {}): MonitorExamDto {
  return {
    recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    monitorLevel: 'YELLOW',
    patientName: '测试患者甲',
    department: '内镜中心',
    bedNo: '12床',
    patientType: { code: 'I', name: '住院' },
    examItem: '胃镜',
    examDate: '2026-09-05',
    examTime: '09:02:00',
    matchedKeywords: ['息肉待复核'],
    ...overrides,
  };
}

/**
 * Deliberately the WIDER workbench detail (issue #88) rather than the base DTO,
 * because that is what MonitorService.getDetail now returns: the alert-link
 * service receives the AI fields and has to narrow them away. A base-typed
 * fixture here would prove nothing.
 */
function makeDetail(
  overrides: Partial<MonitorExamWorkbenchDetailDto> = {},
): MonitorExamWorkbenchDetailDto {
  return {
    ...makeRow(),
    reportContent: '胃窦见一枚 0.6cm 息肉，息肉待复核。',
    diagnosis: '胃息肉。',
    hits: [
      {
        ruleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        ruleVersion: 1,
        keyword: '息肉待复核',
        level: 'YELLOW',
        matchedField: 'FINDINGS',
        contextSnippet: '…息肉待复核。',
        matchedAt: '2026-09-05T01:05:00.000Z',
        // Issue #87 fields: the alert-link path reads record ids/levels only,
        // never hits, so this is just a complete DTO.
        semanticFiltered: false,
        semantic: null,
      },
    ],
    // Issue #88: the report-level AI explanation, present on the object the
    // alert-link service receives.
    attentionSource: 'BOTH',
    aiJudged: true,
    aiSemantics: [
      {
        semanticId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        semanticVersion: 2,
        name: '明确或高度疑似恶性病变',
        attentionLevel: 'RED',
        confidence: 'HIGH',
        reason: '报告描述了不规则隆起与质脆。',
        evidence: [{ field: 'FINDINGS', text: '胃窦见一枚 0.6cm 息肉' }],
      },
    ],
    ...overrides,
  };
}

function build() {
  const prisma = { alertLink: { update: jest.fn(async () => ({ id: 'link-1' })) } };
  const monitor = {
    listByIds: jest.fn(async () => [
      makeRow(),
      makeRow({ recordId: link.recordIds[1], patientName: '李四' }),
    ]),
    getDetail: jest.fn(async () => makeDetail()),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'hospitalName' ? '菏泽市中医医院' : undefined)),
  };
  const service = new AlertLinksService(
    prisma as unknown as PrismaService,
    monitor as unknown as MonitorService,
    config as unknown as ConfigService,
  );
  return { service, prisma, monitor };
}

describe('AlertLinksService', () => {
  describe('open', () => {
    it('returns the link summary and bumps openCount/lastOpenedAt', async () => {
      const { service, prisma } = build();
      const now = new Date('2026-09-05T03:00:00Z');

      const summary = await service.open(link, now);

      expect(summary).toEqual({
        level: 'YELLOW',
        windowDate: '2026-09-05',
        total: 2,
        createdAt: '2026-09-05T01:00:00.000Z',
        expiresAt: '2026-09-06T01:00:00.000Z',
        hospitalName: '菏泽市中医医院',
      });
      expect(prisma.alertLink.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: { openCount: { increment: 1 }, lastOpenedAt: now },
        select: { id: true },
      });
    });
  });

  describe('listExams', () => {
    it('lists exactly the snapshot ids with names masked and bed/department kept', async () => {
      const { service, monitor } = build();

      const result = await service.listExams(link);

      expect(monitor.listByIds).toHaveBeenCalledWith(link.recordIds);
      expect(result.total).toBe(2);
      // maskName keeps the family name and stars the rest: 测试患者甲 -> 测****, 李四 -> 李*.
      expect(result.items[0]).toMatchObject({
        patientName: '测****',
        bedNo: '12床',
        department: '内镜中心',
      });
      expect(result.items[1]).toMatchObject({ patientName: '李*' });
      expect(result.items[0]).not.toHaveProperty('reportContent');
      // Issue #88: and no attentionSource - the H5 list's wire type is the base
      // MonitorExamDto, which has no such field.
      expect(result.items[0]).not.toHaveProperty('attentionSource');
      expect(result).not.toHaveProperty('dataAccess');
    });

    it('returns an empty list for an empty snapshot', async () => {
      const { service, monitor } = build();
      monitor.listByIds.mockResolvedValueOnce([]);

      expect(await service.listExams({ ...link, recordIds: [] })).toEqual({ items: [], total: 0 });
    });
  });

  describe('getExamDetail', () => {
    it('returns the detail with the name masked but report, diagnosis and snippets intact', async () => {
      const { service, monitor } = build();

      const detail = await service.getExamDetail(link, link.recordIds[0]);

      expect(monitor.getDetail).toHaveBeenCalledWith(link.recordIds[0]);
      expect(detail.patientName).toBe('测****');
      expect(detail.bedNo).toBe('12床');
      expect(detail.reportContent).toBe('胃窦见一枚 0.6cm 息肉，息肉待复核。');
      expect(detail.diagnosis).toBe('胃息肉。');
      expect(detail.hits[0].contextSnippet).toBe('…息肉待复核。');
      expect(detail.dataAccess).toBeUndefined();
    });

    it('drops the workbench AI fields so the H5 payload cannot grow them (issue #88)', async () => {
      const { service } = build();

      const detail = await service.getExamDetail(link, link.recordIds[0]);

      // The H5 surface's shape does not change: the owner's rule is that the
      // notification surface stays as it is, and a link can travel further than
      // a workbench session. maskAlertExamDetail BUILDS the base DTO from a
      // whitelist, so this holds for any field added to the workbench later -
      // the assertion is on the absence, not on a remembered deletion.
      expect(detail).not.toHaveProperty('attentionSource');
      expect(detail).not.toHaveProperty('aiJudged');
      expect(detail).not.toHaveProperty('aiSemantics');
      // Everything the H5 page does show is still there.
      expect(detail.reportContent).toBe('胃窦见一枚 0.6cm 息肉，息肉待复核。');
      expect(detail.hits).toHaveLength(1);
    });

    it('answers 404 MONITOR_RECORD_NOT_FOUND for an id outside the snapshot, without querying it', async () => {
      const { service, monitor } = build();

      await expect(
        service.getExamDetail(link, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      ).rejects.toBeInstanceOf(MonitorRecordNotFoundException);
      expect(monitor.getDetail).not.toHaveBeenCalled();
    });
  });
});
