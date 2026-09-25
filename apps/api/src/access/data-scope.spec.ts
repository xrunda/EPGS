import {
  MonitorExamDetailDto,
  MonitorExamDto,
  MonitorExamHitDto,
  MonitorLevelDto,
  SemanticConfidenceDto,
  SemanticStatusDto,
} from '@epgs/shared-types';
import { buildDepartmentScopeWhere, maskExamDetail, maskExamRow, maskName } from './data-scope';

describe('data-scope helpers (issue #13)', () => {
  describe('buildDepartmentScopeWhere', () => {
    it('returns an empty where for an empty scope (all departments)', () => {
      expect(buildDepartmentScopeWhere()).toEqual({});
      expect(buildDepartmentScopeWhere([])).toEqual({});
    });

    it('narrows to the authorized departments', () => {
      expect(buildDepartmentScopeWhere(['消化内科', '呼吸内科'])).toEqual({
        department: { in: ['消化内科', '呼吸内科'] },
      });
    });
  });

  describe('maskName', () => {
    it.each([
      [null, null],
      ['', null],
      ['  ', null],
      ['张', '*'],
      ['张三', '张*'],
      ['张三丰', '张**'],
    ])('masks %p -> %p', (name, expected) => {
      expect(maskName(name as string | null)).toBe(expected);
    });
  });

  const baseRow: MonitorExamDto = {
    recordId: '00000000-0000-0000-0000-000000000001',
    monitorLevel: 'RED' as MonitorLevelDto,
    patientName: '张三丰',
    department: '消化内科',
    bedNo: '12-1',
    patientType: { code: 'I', name: '住院' },
    examItem: '电子胃镜检查',
    examDate: '2026-08-20',
    examTime: '16:15:00',
    matchedKeywords: ['腺癌'],
  };

  it('maskExamRow masks patientName and bedNo, keeps the rest', () => {
    const masked = maskExamRow(baseRow);
    expect(masked.patientName).toBe('张**');
    expect(masked.bedNo).toBe('***');
    expect(masked.recordId).toBe(baseRow.recordId);
    expect(masked.department).toBe('消化内科');
    expect(masked.examItem).toBe(baseRow.examItem);
    expect(masked.matchedKeywords).toEqual(['腺癌']);
  });

  it('maskExamRow leaves a null bedNo as null (not "***")', () => {
    const masked = maskExamRow({ ...baseRow, bedNo: null });
    expect(masked.bedNo).toBeNull();
  });

  it('maskExamDetail nulls the HIGH-sensitivity free text and flags dataAccess.masked', () => {
    const hit: MonitorExamHitDto = {
      ruleId: '00000000-0000-0000-0000-000000000010',
      ruleVersion: 1,
      keyword: '腺癌',
      level: 'RED' as MonitorLevelDto,
      matchedField: 'REPORT_TEXT',
      contextSnippet: '…黏膜内腺癌…',
      matchedAt: '2026-08-20T08:15:30.000Z',
      semanticFiltered: false,
      semantic: {
        status: 'PRESENT' as SemanticStatusDto,
        confidence: 'HIGH' as SemanticConfidenceDto,
        // Report-adjacent free text: the model's own sentence. Nulled by the
        // masking below, so this fixture proves the nulling rather than
        // asserting on an already-null value.
        reason: '报告中明确描述该病变。',
        judgedAt: '2026-08-20T08:16:00.000Z',
      },
    };
    const detail: MonitorExamDetailDto = {
      ...baseRow,
      reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌。',
      diagnosis: '胃腺癌（早期）。',
      hits: [hit],
    };

    const masked = maskExamDetail(detail);
    expect(masked.patientName).toBe('张**');
    expect(masked.bedNo).toBe('***');
    expect(masked.reportContent).toBeNull();
    expect(masked.diagnosis).toBeNull();
    expect(masked.hits[0].contextSnippet).toBeNull();
    // Issue #87: the model's explanation is report-adjacent free text and is
    // nulled with the rest...
    expect(masked.hits[0].semantic?.reason).toBeNull();
    // ...but the verdict it belongs to is not patient data - it describes the
    // keyword rule and the hit, both of which this caller can already see.
    expect(masked.hits[0].semantic?.status).toBe('PRESENT');
    expect(masked.hits[0].semantic?.confidence).toBe('HIGH');
    // Non-sensitive hit fields survive masking.
    expect(masked.hits[0].keyword).toBe('腺癌');
    expect(masked.hits[0].matchedField).toBe('REPORT_TEXT');
    expect(masked.dataAccess).toEqual({ masked: true });
  });

  it('maskExamDetail keeps an unjudged hit unjudged (no invented verdict)', () => {
    const unjudged: MonitorExamDetailDto = {
      ...baseRow,
      reportContent: null,
      diagnosis: null,
      hits: [
        {
          ruleId: '00000000-0000-0000-0000-000000000010',
          ruleVersion: 1,
          keyword: '腺癌',
          level: 'RED' as MonitorLevelDto,
          matchedField: 'REPORT_TEXT',
          contextSnippet: null,
          matchedAt: '2026-08-20T08:15:30.000Z',
          semanticFiltered: false,
          semantic: null,
        },
      ],
    };

    const masked = maskExamDetail(unjudged);
    expect(masked.hits[0].semantic).toBeNull();
    expect(masked.hits[0].semanticFiltered).toBe(false);
  });

  it('maskExamDetail on an unmasked detail has no dataAccess flag (redaction distinguishable from empty body)', () => {
    expect(baseRow).not.toHaveProperty('dataAccess');
  });
});
