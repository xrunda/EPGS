import {
  MonitorAiSemanticDto,
  MonitorExamDto,
  MonitorExamHitDto,
  MonitorExamWorkbenchDetailDto,
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

  /**
   * Issue #88: one report-level AI finding, complete with the model's sentence
   * and a verbatim excerpt. Both are report-adjacent free text, so the mask test
   * below proves they are nulled rather than asserting on already-null values.
   */
  const aiFinding: MonitorAiSemanticDto = {
    semanticId: '00000000-0000-0000-0000-000000000020',
    semanticVersion: 3,
    name: '明确或高度疑似恶性病变',
    attentionLevel: 'RED',
    confidence: 'HIGH' as SemanticConfidenceDto,
    reason: '报告描述了不规则隆起与质脆，提示恶性可能。',
    evidence: [{ field: 'FINDINGS', text: '胃窦见一处隆起性病变' }],
  };

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
    const detail: MonitorExamWorkbenchDetailDto = {
      ...baseRow,
      reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌。',
      diagnosis: '胃腺癌（早期）。',
      hits: [hit],
      attentionSource: 'BOTH',
      aiJudged: true,
      aiSemantics: [aiFinding],
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

    // Issue #88: the model's sentence and every excerpt are report-adjacent free
    // text, so both go...
    expect(masked.aiSemantics).toHaveLength(1);
    expect(masked.aiSemantics[0].reason).toBeNull();
    expect(masked.aiSemantics[0].evidence).toEqual([]);
    // ...but the finding itself stays. Without it a record flagged only by the AI
    // (no keyword hit at all) would be RED with nothing on screen to explain it.
    expect(masked.aiSemantics[0].name).toBe('明确或高度疑似恶性病变');
    expect(masked.aiSemantics[0].attentionLevel).toBe('RED');
    expect(masked.aiSemantics[0].confidence).toBe('HIGH');
    // Provenance of the LEVEL, which this caller already sees - not patient data.
    expect(masked.attentionSource).toBe('BOTH');
    expect(masked.aiJudged).toBe(true);

    expect(masked.dataAccess).toEqual({ masked: true });
  });

  it('maskExamDetail keeps an unjudged hit unjudged (no invented verdict)', () => {
    const unjudged: MonitorExamWorkbenchDetailDto = {
      ...baseRow,
      reportContent: null,
      diagnosis: null,
      attentionSource: 'RULE',
      aiJudged: false,
      aiSemantics: [],
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
