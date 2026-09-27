import { LevelConflict } from '../monitor/level-conflict';
import {
  ConflictOccurrence,
  aggregateConflicts,
  buildConflictKey,
  parseConflictKey,
} from './level-conflicts.mapper';

/**
 * Pure-logic tests for issue #103's admin-side key and aggregation.
 *
 * The key group is the important one. The key is what an admin's read decision
 * is STORED against, so build and parse have to agree exactly - and, just as
 * importantly, two conflicts that a human would call different must not collapse
 * into one key, or marking one read would silently mark the other. The
 * near-misses below (same rules, different column; same everything, one level
 * re-coloured) are the cases that would do exactly that.
 */

const RULE_GROUP = '11111111-1111-4111-8111-111111111111';
const OTHER_RULE_GROUP = '33333333-3333-4333-8333-333333333333';
const SEMANTIC_GROUP = '22222222-2222-4222-8222-222222222222';

function makeConflict(overrides: Partial<LevelConflict> = {}): LevelConflict {
  return {
    ruleGroupId: RULE_GROUP,
    semanticGroupId: SEMANTIC_GROUP,
    keyword: '隆起',
    keywordLevel: 'RED',
    semanticName: '性质待定、需活检或短期复查的病变',
    semanticLevel: 'YELLOW',
    field: 'FINDINGS',
    ...overrides,
  };
}

describe('buildConflictKey / parseConflictKey (issue #103)', () => {
  it('round-trips through the key', () => {
    const conflict = makeConflict();

    expect(parseConflictKey(buildConflictKey(conflict))).toEqual({
      ruleGroupId: RULE_GROUP,
      semanticGroupId: SEMANTIC_GROUP,
      field: 'FINDINGS',
      keywordLevel: 'RED',
      aiLevel: 'YELLOW',
    });
  });

  it('is stable across a rule re-wording and a semantic version bump', () => {
    // The whole reason the key is built from GROUP ids. A rule edit creates a new
    // versioned row; if the key mentioned it, an admin would fix a conflict, see
    // it vanish, and watch it come back the next time someone touched the wording.
    // `keyword`/`semanticName` are snapshots and legitimately change, so they are
    // not in the key either.
    const before = makeConflict();
    const after = makeConflict({ keyword: '隆起性病变', semanticName: '重新措辞过的名字' });

    expect(buildConflictKey(after)).toBe(buildConflictKey(before));
  });

  it('separates the two report columns', () => {
    // One rule can hit both reportContent and diagnosis. Those are two different
    // places in the report - collapsing them would let one read decision hide a
    // second, unrelated disagreement.
    expect(buildConflictKey(makeConflict({ field: 'IMPRESSION' }))).not.toBe(
      buildConflictKey(makeConflict({ field: 'FINDINGS' })),
    );
  });

  it('separates a re-coloured side, in both directions', () => {
    // Re-colouring either side is a DIFFERENT disagreement with a different
    // answer, so it must come back unread rather than inherit the old decision.
    const base = buildConflictKey(makeConflict());

    expect(buildConflictKey(makeConflict({ keywordLevel: 'GREEN' }))).not.toBe(base);
    expect(buildConflictKey(makeConflict({ semanticLevel: 'RED' }))).not.toBe(base);
  });

  it('separates two different rules that render identically to a doctor', () => {
    // The admin's list must keep these apart: two rules with the same keyword and
    // level are two separate pieces of configuration to fix, even though the
    // doctor's drawer collapses them into one sentence.
    expect(buildConflictKey(makeConflict({ ruleGroupId: OTHER_RULE_GROUP }))).not.toBe(
      buildConflictKey(makeConflict()),
    );
  });

  it.each([
    ['', 'empty'],
    ['not-a-key', 'too few parts'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:RED`, 'too few parts'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:RED:YELLOW:extra`, 'too many parts'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:RED:PURPLE`, 'unknown AI level'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:PURPLE:YELLOW`, 'unknown keyword level'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:EXAM_ITEM:RED:YELLOW`, 'a field no hit can pair in'],
    [`${RULE_GROUP}:${SEMANTIC_GROUP}:FINDINGS:YELLOW:UNCLASSIFIED`, 'the AI has no UNCLASSIFIED'],
    [`not-a-uuid:${SEMANTIC_GROUP}:FINDINGS:RED:YELLOW`, 'rule group is not a uuid'],
    [`${RULE_GROUP}:not-a-uuid:FINDINGS:RED:YELLOW`, 'semantic group is not a uuid'],
  ])('rejects %s (%s)', (key) => {
    expect(parseConflictKey(key)).toBeNull();
  });
});

describe('aggregateConflicts (issue #103)', () => {
  function occurrence(
    conflict: LevelConflict,
    seenAt: string,
  ): ConflictOccurrence {
    return { conflict, seenAt: new Date(seenAt) };
  }

  it('folds many records into one entry, counting them and keeping the latest', () => {
    const conflict = makeConflict();
    const result = aggregateConflicts(
      [
        occurrence(conflict, '2026-09-20T02:00:00.000Z'),
        occurrence(conflict, '2026-09-26T02:00:00.000Z'),
        occurrence(conflict, '2026-09-10T02:00:00.000Z'),
      ],
      new Map(),
    );

    expect(result).toHaveLength(1);
    expect(result[0].recordCount).toBe(3);
    expect(result[0].lastSeenAt).toBe('2026-09-26T02:00:00.000Z');
    expect(result[0].readAt).toBeNull();
  });

  it('carries the read state, and treats a null value as unread', () => {
    const key = buildConflictKey(makeConflict());
    const readAt = new Date('2026-09-25T01:00:00.000Z');

    expect(aggregateConflicts([occurrence(makeConflict(), '2026-09-26T02:00:00.000Z')], new Map([[key, readAt]]))[0].readAt).toBe(readAt.toISOString());
    // A row that exists but is marked unread (issue #103 keeps it rather than
    // deleting it) is unread.
    expect(
      aggregateConflicts([occurrence(makeConflict(), '2026-09-26T02:00:00.000Z')], new Map([[key, null]]))[0]
        .readAt,
    ).toBeNull();
  });

  it('puts unread first, then most recently seen', () => {
    const read = makeConflict({ ruleGroupId: OTHER_RULE_GROUP });
    const readKey = buildConflictKey(read);

    const result = aggregateConflicts(
      [
        occurrence(read, '2026-09-26T02:00:00.000Z'), // newest overall, but read
        occurrence(makeConflict({ field: 'IMPRESSION' }), '2026-09-01T02:00:00.000Z'),
        occurrence(makeConflict(), '2026-09-20T02:00:00.000Z'),
      ],
      new Map([[readKey, new Date('2026-09-26T03:00:00.000Z')]]),
    );

    // Unread by recency first; the read one last despite being the newest thing
    // in the window - a read entry is one an admin has already dealt with.
    expect(result.map((item) => item.lastSeenAt)).toEqual([
      '2026-09-20T02:00:00.000Z',
      '2026-09-01T02:00:00.000Z',
      '2026-09-26T02:00:00.000Z',
    ]);
  });

  it('breaks a same-instant tie by key, so the order never depends on input order', () => {
    const a = makeConflict({ ruleGroupId: RULE_GROUP });
    const b = makeConflict({ ruleGroupId: OTHER_RULE_GROUP });
    const seenAt = '2026-09-26T02:00:00.000Z';

    const forward = aggregateConflicts([occurrence(a, seenAt), occurrence(b, seenAt)], new Map());
    const backward = aggregateConflicts([occurrence(b, seenAt), occurrence(a, seenAt)], new Map());

    expect(forward.map((item) => item.conflictKey)).toEqual(backward.map((item) => item.conflictKey));
    expect(forward.map((item) => item.conflictKey)).toEqual(
      [buildConflictKey(a), buildConflictKey(b)].sort(),
    );
  });

  it('returns nothing for no occurrences', () => {
    expect(aggregateConflicts([], new Map())).toEqual([]);
  });
});
