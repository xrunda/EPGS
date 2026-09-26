import { createHash } from 'node:crypto';
import {
  ReportAiAttemptRow,
  ReportAiMatchRow,
  ReportAiRecordRow,
  toAiJudged,
  toAiSemantics,
  toAttentionSource,
} from './report-ai.mapper';

/**
 * Pure-logic tests for the issue #88 (PR-B) explanation mapping.
 *
 * Two of these groups are safety rules rather than formatting, and are the
 * reason this module exists at all:
 *  - WHICH attempt may be shown (the audit tables are append-only, so a record
 *    whose report text was replaced still has stale rows pointing into the OLD
 *    text);
 *  - WHETHER an excerpt may be shown (only its hash and offsets are stored, so
 *    it is recomputed on every read and must be dropped the moment it stops
 *    landing on the text it was computed against).
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const REPORT = '胃体见巨大不规则隆起，\n表面糜烂，质脆。';
const DIAGNOSIS = '胃体占位，性质待定。';
const EXAM_ITEM = '电子胃镜检查';

function makeRecord(overrides: Partial<ReportAiRecordRow> = {}): ReportAiRecordRow {
  return {
    reportVersion: 1,
    aiAttentionLevel: 'RED',
    aiResolvedAt: new Date('2026-09-26T02:00:00.000Z'),
    examItem: EXAM_ITEM,
    reportContent: REPORT,
    diagnosis: DIAGNOSIS,
    ...overrides,
  };
}

function makeEvidence(overrides: Record<string, unknown> = {}): any {
  return {
    ordinal: 0,
    field: 'FINDINGS',
    evidenceHash: sha256Hex(REPORT),
    evidenceStart: 0,
    evidenceEnd: REPORT.length,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<ReportAiMatchRow> = {}): ReportAiMatchRow {
  return {
    semanticId: '11111111-1111-4111-8111-111111111111',
    semanticVersion: 3,
    semanticName: '明确或高度疑似恶性病变',
    attentionLevel: 'RED',
    confidence: 'HIGH',
    reason: '报告描述了不规则隆起与质脆，提示恶性可能。',
    ordinal: 0,
    evidence: [makeEvidence()],
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<ReportAiAttemptRow> = {}): ReportAiAttemptRow {
  return {
    reportVersion: 1,
    createdAt: new Date('2026-09-26T02:00:00.000Z'),
    matches: [makeMatch()],
    ...overrides,
  };
}

describe('toAttentionSource', () => {
  it('reports which path found something, without comparing the two levels', () => {
    expect(toAttentionSource(true, null)).toBe('RULE');
    expect(toAttentionSource(false, 'GREEN')).toBe('AI_REPORT');
    expect(toAttentionSource(true, 'YELLOW')).toBe('BOTH');
    expect(toAttentionSource(false, null)).toBe('NONE');
  });

  it('is BOTH even when the AI level is the LOWER one', () => {
    // A keyword RED with an AI YELLOW means both paths found something a doctor
    // should read. The badge answers "who found something", not "who decided
    // the level" - so it must not depend on which level is higher.
    expect(toAttentionSource(true, 'YELLOW')).toBe('BOTH');
    expect(toAttentionSource(true, 'GREEN')).toBe('BOTH');
  });
});

describe('toAiJudged', () => {
  it('is true when an OK attempt exists for the current report version', () => {
    expect(toAiJudged([makeAttempt()], makeRecord())).toBe(true);
  });

  it('is true for an OK attempt that matched nothing - "looked, found nothing"', () => {
    // This is the state the doctor could not otherwise tell apart from "the AI
    // never ran"; aiAttentionLevel stays NULL (a genuine NONE) but the attempt
    // itself is real.
    const record = makeRecord({ aiAttentionLevel: null });
    expect(toAiJudged([makeAttempt({ matches: [] })], record)).toBe(true);
  });

  it('is false when the only attempt was made against different text', () => {
    expect(toAiJudged([makeAttempt({ reportVersion: 2 })], makeRecord())).toBe(false);
    expect(toAiJudged([], makeRecord())).toBe(false);
  });

  it('is false when AI state is present but no attempt was selected', () => {
    expect(toAiJudged([], makeRecord({ aiAttentionLevel: 'YELLOW' }))).toBe(false);
  });
});

describe('toAiSemantics - attempt selection', () => {
  it('returns nothing when no attempt was made', () => {
    expect(toAiSemantics([], makeRecord())).toEqual([]);
  });

  it('returns nothing when the only attempt was made against a different report version', () => {
    // A superseded verdict is stale, not an alternative: an older attempt must
    // never be substituted for the current one.
    expect(toAiSemantics([makeAttempt({ reportVersion: 2 })], makeRecord())).toEqual([]);
  });

  it('returns nothing when the AI does not contribute to the current level', () => {
    // The load-bearing guard. Between a re-sync replacing the report text
    // (which nulls aiAttentionLevel) and the re-classification landing, the old
    // append-only rows are still there - and showing them would make the drawer
    // contradict a level that now says the AI found nothing.
    const record = makeRecord({ aiAttentionLevel: null });
    expect(toAiSemantics([makeAttempt()], record)).toEqual([]);
  });

  it('returns nothing for an OK attempt with zero matches', () => {
    expect(toAiSemantics([makeAttempt({ matches: [] })], makeRecord())).toEqual([]);
  });

  it('prefers the attempt that produced the current AI state over a newer loser', () => {
    // A concurrent attempt that lost the `aiResolvedAt: null` guard still
    // writes its audit row without touching the record (one row per attempt is
    // the provenance trail), so the newest row is not necessarily the one in
    // force. classify.store.ts writes the same `now` into the winner's
    // createdAt and the record's aiResolvedAt.
    const winner = makeAttempt({
      createdAt: new Date('2026-09-26T02:00:00.000Z'),
      matches: [makeMatch({ semanticName: '生效的那次判读' })],
    });
    const straggler = makeAttempt({
      createdAt: new Date('2026-09-26T02:05:00.000Z'),
      matches: [makeMatch({ semanticName: '没生效的那次判读' })],
    });

    // Newest first, as DETAIL_INCLUDE orders them.
    const result = toAiSemantics([straggler, winner], makeRecord());

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('生效的那次判读');
  });

  it('falls back to the newest attempt when nothing matches aiResolvedAt', () => {
    const older = makeAttempt({ createdAt: new Date('2026-09-26T01:00:00.000Z') });
    const newer = makeAttempt({
      createdAt: new Date('2026-09-26T03:00:00.000Z'),
      matches: [makeMatch({ semanticName: '最新一次' })],
    });

    const result = toAiSemantics([newer, older], makeRecord());

    expect(result.map((finding) => finding.name)).toEqual(['最新一次']);
  });
});

describe('toAiSemantics - finding shape', () => {
  it('carries the configured snapshot, the confidence and the reason', () => {
    const [finding] = toAiSemantics([makeAttempt()], makeRecord());

    expect(finding).toMatchObject({
      semanticId: '11111111-1111-4111-8111-111111111111',
      semanticVersion: 3,
      name: '明确或高度疑似恶性病变',
      attentionLevel: 'RED',
      confidence: 'HIGH',
      reason: '报告描述了不规则隆起与质脆，提示恶性可能。',
    });
  });

  it('orders RED before GREEN regardless of the stored ordinal', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({ ordinal: 0, attentionLevel: 'GREEN', semanticName: '绿色那条' }),
        makeMatch({ ordinal: 1, attentionLevel: 'RED', semanticName: '红色那条' }),
        makeMatch({ ordinal: 2, attentionLevel: 'YELLOW', semanticName: '黄色那条' }),
      ],
    });

    const result = toAiSemantics([attempt], makeRecord());

    expect(result.map((finding) => finding.name)).toEqual(['红色那条', '黄色那条', '绿色那条']);
  });

  it('keeps the model ordinal order within one attention level', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({ ordinal: 2, semanticName: '第二条' }),
        makeMatch({ ordinal: 1, semanticName: '第一条' }),
      ],
    });

    const result = toAiSemantics([attempt], makeRecord());

    expect(result.map((finding) => finding.name)).toEqual(['第一条', '第二条']);
  });
});

describe('evidence reconstruction', () => {
  it('returns the excerpt verbatim, labelled with the field it came from', () => {
    const [finding] = toAiSemantics([makeAttempt()], makeRecord());

    expect(finding.evidence).toEqual([{ field: 'FINDINGS', text: REPORT }]);
  });

  it('maps each ReportAiField to its own report column', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [
            makeEvidence({
              ordinal: 0,
              field: 'EXAM_ITEM',
              evidenceHash: sha256Hex(EXAM_ITEM),
              evidenceStart: 0,
              evidenceEnd: EXAM_ITEM.length,
            }),
            makeEvidence({
              ordinal: 1,
              field: 'FINDINGS',
              evidenceHash: sha256Hex(REPORT),
              evidenceStart: 0,
              evidenceEnd: REPORT.length,
            }),
            makeEvidence({
              ordinal: 2,
              field: 'IMPRESSION',
              evidenceHash: sha256Hex(DIAGNOSIS),
              evidenceStart: 0,
              evidenceEnd: DIAGNOSIS.length,
            }),
          ],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord());

    expect(finding.evidence).toEqual([
      { field: 'EXAM_ITEM', text: EXAM_ITEM },
      { field: 'FINDINGS', text: REPORT },
      { field: 'IMPRESSION', text: DIAGNOSIS },
    ]);
  });

  it('accepts an excerpt the verifier located by collapsing whitespace', () => {
    // verifyEvidence's retry stores the hash of the WHITESPACE-COLLAPSED form
    // while the offsets point at the original text (which still has the
    // newline). An exact-only comparison would silently drop honest evidence -
    // this is the subtlest correctness detail in the PR.
    const collapsed = REPORT.replace(/\s+/g, ' ');
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [
            makeEvidence({
              evidenceHash: sha256Hex(collapsed),
              evidenceStart: 0,
              evidenceEnd: REPORT.length,
            }),
          ],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord());

    // The ORIGINAL text is returned, not the collapsed form: the excerpt is
    // shown as the report actually reads.
    expect(finding.evidence).toEqual([{ field: 'FINDINGS', text: REPORT }]);
  });

  it('drops the excerpt but keeps the finding when the text no longer matches', () => {
    // The offsets still land inside the body, so a bounds-only check would show
    // a slice of text the model never quoted. The hash is what catches it.
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [makeEvidence({ evidenceHash: sha256Hex('另一份报告的完全不同的一段话') })],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord());

    expect(finding.name).toBe('明确或高度疑似恶性病变');
    expect(finding.evidence).toEqual([]);
  });

  const badOffsets: [string, Record<string, number>][] = [
    ['end past the end of the text', { evidenceStart: 0, evidenceEnd: REPORT.length + 1 }],
    ['start past the end of the text', { evidenceStart: REPORT.length + 1, evidenceEnd: 999 }],
    ['start equal to end', { evidenceStart: 5, evidenceEnd: 5 }],
    ['start after end', { evidenceStart: 8, evidenceEnd: 3 }],
    ['negative start', { evidenceStart: -1, evidenceEnd: 5 }],
    ['non-integer offset', { evidenceStart: 1.5, evidenceEnd: 5 }],
  ];

  it.each(badOffsets)('drops the excerpt on %s', (_label, offsets) => {
    const attempt = makeAttempt({
      matches: [makeMatch({ evidence: [makeEvidence(offsets)] })],
    });

    const [finding] = toAiSemantics([attempt], makeRecord());

    expect(finding.evidence).toEqual([]);
    expect(finding.name).toBe('明确或高度疑似恶性病变');
  });

  it('drops the excerpt when its report column is now empty', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [makeEvidence({ field: 'IMPRESSION', evidenceStart: 0, evidenceEnd: 3 })],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord({ diagnosis: null }));

    expect(finding.evidence).toEqual([]);
  });

  it('drops a whitespace-only excerpt rather than showing a blank quote', () => {
    const text = '前段。   \n  后段。';
    // slice(3, 8) is '   \n ' - three spaces, a newline and one more space.
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [
            makeEvidence({
              evidenceHash: sha256Hex('   \n '),
              evidenceStart: 3,
              evidenceEnd: 8,
            }),
          ],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord({ reportContent: text }));

    expect(finding.evidence).toEqual([]);
  });

  it('keeps the findings that do have usable evidence', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          ordinal: 0,
          semanticName: '有证据的',
          evidence: [makeEvidence()],
        }),
        makeMatch({
          ordinal: 1,
          semanticName: '证据过期的',
          evidence: [makeEvidence({ evidenceStart: 0, evidenceEnd: 9999 })],
        }),
      ],
    });

    const result = toAiSemantics([attempt], makeRecord());

    expect(result.map((finding) => [finding.name, finding.evidence.length])).toEqual([
      ['有证据的', 1],
      ['证据过期的', 0],
    ]);
  });

  it('orders evidence by its stored ordinal', () => {
    const attempt = makeAttempt({
      matches: [
        makeMatch({
          evidence: [
            makeEvidence({
              ordinal: 1,
              evidenceHash: sha256Hex(DIAGNOSIS),
              field: 'IMPRESSION',
              evidenceStart: 0,
              evidenceEnd: DIAGNOSIS.length,
            }),
            makeEvidence({ ordinal: 0 }),
          ],
        }),
      ],
    });

    const [finding] = toAiSemantics([attempt], makeRecord());

    expect(finding.evidence.map((excerpt) => excerpt.field)).toEqual(['FINDINGS', 'IMPRESSION']);
  });
});
