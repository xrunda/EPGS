import {
  ConflictEvidenceInput,
  ConflictFindingInput,
  ConflictHitInput,
  findLevelConflicts,
} from './level-conflict';

/**
 * Pure-logic tests for the issue #103 disagreement rule.
 *
 * The rule points a doctor at ONE place in the report and says the two paths
 * disagree about it. Every way of getting that wrong is a way of telling a doctor
 * two things are the same thing when they are not - so the coverage here is
 * deliberately about the NEAR MISSES: adjacent-but-not-overlapping ranges, the
 * same words found in a different column, a level that agrees, and the field
 * values that have no single column at all.
 *
 * The fallback for hits with no offsets gets its own group. It is the one branch
 * that reads something the other branch does not, and the rows it exists for -
 * everything written before #87 - are exactly the rows that would otherwise be
 * excluded without anyone noticing.
 *
 * Ordering assertions use ASCII names: the comparator is a code-unit comparison,
 * not a locale collation, and a test that depends on ICU's pinyin order would be
 * asserting the host environment rather than the rule.
 */

const REPORT = '胃体见巨大不规则隆起，表面糜烂，质脆。';
// Indices for reference (UTF-16 code units, as stored):
//   0 胃 1 体 2 见 3 巨 4 大 5 不 6 规 7 则 8 隆 9 起 10 ， 11 表 12 面 13 糜 14 烂 15 ，
//   16 质 17 脆 18 。
const RU_LONGQI = REPORT.slice(5, 10); // 不规则隆起
const ZHICUI = REPORT.slice(16, 18); // 质脆

const RULE_GROUP = '11111111-1111-4111-8111-111111111111';
const OTHER_RULE_GROUP = '33333333-3333-4333-8333-333333333333';
const SEMANTIC_GROUP = '22222222-2222-4222-8222-222222222222';

function makeHit(overrides: Partial<ConflictHitInput> = {}): ConflictHitInput {
  return {
    ruleGroupId: RULE_GROUP,
    keyword: '隆起',
    level: 'RED',
    matchedField: 'FINDINGS',
    matchStart: 8,
    matchEnd: 10,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<ConflictEvidenceInput> = {}): ConflictEvidenceInput {
  return {
    field: 'FINDINGS',
    start: 5,
    end: 10,
    text: RU_LONGQI,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ConflictFindingInput> = {}): ConflictFindingInput {
  return {
    semanticGroupId: SEMANTIC_GROUP,
    semanticName: '性质待定、需活检或短期复查的病变',
    attentionLevel: 'YELLOW',
    evidence: [makeEvidence()],
    ...overrides,
  };
}

/** A finding whose single excerpt sits at the given offsets in the findings column. */
function findingAt(start: number, end: number): ConflictFindingInput {
  return makeFinding({
    evidence: [makeEvidence({ start, end, text: REPORT.slice(start, end) })],
  });
}

function find(
  hits: ConflictHitInput[],
  findings: ConflictFindingInput[],
): ReturnType<typeof findLevelConflicts> {
  return findLevelConflicts({ hits, findings });
}

describe('findLevelConflicts - the same place, two different levels', () => {
  it('reports a keyword hit and a finding whose ranges overlap', () => {
    expect(find([makeHit()], [makeFinding()])).toEqual([
      {
        ruleGroupId: RULE_GROUP,
        semanticGroupId: SEMANTIC_GROUP,
        keyword: '隆起',
        keywordLevel: 'RED',
        semanticName: '性质待定、需活检或短期复查的病变',
        semanticLevel: 'YELLOW',
        field: 'FINDINGS',
      },
    ]);
  });

  it('reports the disagreement whichever side asked for the higher level', () => {
    // The rule compares levels, it does not rank them: "the AI raised it" and
    // "the AI lowered it" are the same finding for a doctor and the same
    // configuration problem for an admin.
    expect(find([makeHit({ level: 'GREEN' })], [makeFinding({ attentionLevel: 'RED' })])).toHaveLength(
      1,
    );
    expect(find([makeHit({ level: 'RED' })], [makeFinding({ attentionLevel: 'GREEN' })])).toHaveLength(
      1,
    );
  });

  it('says nothing when the two sides agree on the level', () => {
    expect(find([makeHit({ level: 'YELLOW' })], [makeFinding()])).toEqual([]);
    expect(find([makeHit({ level: 'RED' })], [makeFinding({ attentionLevel: 'RED' })])).toEqual([]);
  });

  it('says nothing when there is only one side', () => {
    expect(find([makeHit()], [])).toEqual([]);
    expect(find([], [makeFinding()])).toEqual([]);
  });

  it('pairs a hit in the diagnosis with a finding in the diagnosis', () => {
    const conflicts = find(
      [makeHit({ matchedField: 'IMPRESSION', matchStart: 0, matchEnd: 2 })],
      [
        makeFinding({
          evidence: [makeEvidence({ field: 'IMPRESSION', start: 0, end: 2, text: ZHICUI })],
        }),
      ],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('IMPRESSION');
  });
});

describe('findLevelConflicts - what does NOT count as the same place', () => {
  it('does not treat two adjacent ranges as an overlap', () => {
    // Half-open ranges: the keyword ends exactly where the quote begins. Those
    // are neighbouring findings, not one finding, so pairing them would invent a
    // disagreement between two unrelated rules.
    expect(find([makeHit({ matchStart: 8, matchEnd: 10 })], [findingAt(10, 15)])).toEqual([]);
    expect(find([makeHit({ matchStart: 5, matchEnd: 10 })], [findingAt(0, 5)])).toEqual([]);
  });

  it('does not pair the same words found in different columns', () => {
    // A keyword hit in the findings and a finding in the impression are two
    // different places even when the text is identical - the offsets are into
    // different columns and are not comparable.
    expect(
      find(
        [makeHit({ matchedField: 'FINDINGS' })],
        [makeFinding({ evidence: [makeEvidence({ field: 'IMPRESSION' })] })],
      ),
    ).toEqual([]);
  });

  it('never pairs an exam-item finding, because no hit can be in the exam item', () => {
    expect(
      find(
        [makeHit({ matchedField: 'FINDINGS' })],
        [makeFinding({ evidence: [makeEvidence({ field: 'EXAM_ITEM' })] })],
      ),
    ).toEqual([]);
  });

  it.each(['STUDY_DESCRIPTION', 'REPORT_TEXT', 'OTHER'] as const)(
    'never pairs a hit whose matchedField is %s, however well the offsets line up',
    (matchedField) => {
      // These three have no single knowable column. The matcher never actually
      // stores them - it persists the concrete column the text came from - but
      // the field type allows them, so the rule refuses rather than guesses.
      expect(find([makeHit({ matchedField })], [makeFinding()])).toEqual([]);
    },
  );

  it('refuses a range that cannot be a range', () => {
    expect(find([makeHit({ matchStart: -1, matchEnd: 10 })], [makeFinding()])).toEqual([]);
    expect(find([makeHit({ matchStart: 10, matchEnd: 10 })], [makeFinding()])).toEqual([]);
    expect(find([makeHit({ matchStart: 12, matchEnd: 10 })], [makeFinding()])).toEqual([]);
    expect(find([makeHit({ matchStart: 1.5, matchEnd: 10 })], [makeFinding()])).toEqual([]);
    expect(
      find([makeHit()], [makeFinding({ evidence: [makeEvidence({ start: 1.5, end: 10 })] })]),
    ).toEqual([]);
  });
});

describe('findLevelConflicts - the fallback for hits with no offsets', () => {
  // match_start is NULL for everything written before #87. Those hits have no
  // interval to intersect, so the only evidence of "same place" left is that the
  // excerpt the AI verified contains the keyword.

  it('pairs when the verified excerpt contains the keyword', () => {
    const conflicts = find(
      [makeHit({ keyword: ZHICUI, matchStart: null, matchEnd: null })],
      [makeFinding({ evidence: [makeEvidence({ start: 16, end: 18, text: ZHICUI })] })],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].keyword).toBe(ZHICUI);
  });

  it('does not pair when the excerpt does not contain the keyword', () => {
    expect(
      find(
        [makeHit({ keyword: ZHICUI, matchStart: null, matchEnd: null })],
        [makeFinding({ evidence: [makeEvidence({ start: 5, end: 10, text: RU_LONGQI })] })],
      ),
    ).toEqual([]);
  });

  it('does not pair when the excerpt could not be recomputed', () => {
    // A stale offset means containment cannot be checked, and an unchecked
    // containment claim is not a claim. Under-reporting is the safe direction.
    expect(
      find(
        [makeHit({ matchStart: null, matchEnd: null })],
        [makeFinding({ evidence: [makeEvidence({ text: null })] })],
      ),
    ).toEqual([]);
  });

  it('still requires the columns to match', () => {
    expect(
      find(
        [makeHit({ matchedField: 'FINDINGS', matchStart: null, matchEnd: null })],
        [makeFinding({ evidence: [makeEvidence({ field: 'IMPRESSION', text: '隆起' })] })],
      ),
    ).toEqual([]);
  });

  it('still requires the levels to differ', () => {
    expect(
      find(
        [makeHit({ level: 'YELLOW', matchStart: null, matchEnd: null })],
        [makeFinding({ attentionLevel: 'YELLOW' })],
      ),
    ).toEqual([]);
  });

  it('pairs only the evidence rows that actually contain the keyword', () => {
    const conflicts = find(
      [makeHit({ keyword: ZHICUI, matchStart: null, matchEnd: null })],
      [
        makeFinding({
          evidence: [
            makeEvidence({ field: 'IMPRESSION', start: 0, end: 2, text: ZHICUI }),
            makeEvidence({ field: 'FINDINGS', start: 16, end: 18, text: ZHICUI }),
          ],
        }),
      ],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('FINDINGS');
  });
});

describe('findLevelConflicts - how pairs are counted', () => {
  it('counts one conflict per finding, not one per verified excerpt', () => {
    // A finding can carry several excerpts; a doctor reads one sentence.
    const conflicts = find(
      [makeHit()],
      [
        makeFinding({
          evidence: [
            makeEvidence({ start: 5, end: 10, text: RU_LONGQI }),
            makeEvidence({ start: 6, end: 10, text: REPORT.slice(6, 10) }),
          ],
        }),
      ],
    );

    expect(conflicts).toHaveLength(1);
  });

  it('reports one conflict per finding when a hit overlaps several findings', () => {
    const conflicts = find(
      [makeHit()],
      [makeFinding({ semanticName: 'finding-a' }), makeFinding({ semanticName: 'finding-b' })],
    );

    expect(conflicts.map((conflict) => conflict.semanticName)).toEqual(['finding-a', 'finding-b']);
  });

  it('reports one conflict per hit when a finding overlaps several hits', () => {
    const conflicts = find(
      [
        makeHit({ ruleGroupId: RULE_GROUP, keyword: 'hit-a', matchStart: 8, matchEnd: 10 }),
        makeHit({ ruleGroupId: OTHER_RULE_GROUP, keyword: 'hit-b', matchStart: 5, matchEnd: 8 }),
      ],
      [makeFinding()],
    );

    expect(conflicts.map((conflict) => conflict.keyword)).toEqual(['hit-a', 'hit-b']);
    expect(conflicts.map((conflict) => conflict.ruleGroupId)).toEqual([
      RULE_GROUP,
      OTHER_RULE_GROUP,
    ]);
  });

  it('keeps two different rules apart even when they share a keyword and a level', () => {
    // Two rules with identical text are two configuration problems for an admin,
    // even though a doctor reads them as one sentence. The doctor's mapper is
    // what collapses them; this list must not lose one.
    const conflicts = find([makeHit(), makeHit({ ruleGroupId: OTHER_RULE_GROUP })], [makeFinding()]);

    expect(conflicts.map((conflict) => conflict.ruleGroupId)).toEqual([
      RULE_GROUP,
      OTHER_RULE_GROUP,
    ]);
  });

  it('returns the same order for the same input, whatever order the findings arrive in', () => {
    const hits = [makeHit({ keyword: 'hit-a' })];
    const findings = [
      makeFinding({ semanticName: 'finding-b' }),
      makeFinding({ semanticName: 'finding-a' }),
    ];

    const names = ['finding-a', 'finding-b'];
    expect(find(hits, findings).map((conflict) => conflict.semanticName)).toEqual(names);
    expect(find(hits, [...findings].reverse()).map((conflict) => conflict.semanticName)).toEqual(names);
  });
});
