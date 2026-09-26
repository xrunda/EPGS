import { computeEffectiveLevel, LevelClient, recomputeRecordLevels } from './record-level';

/**
 * The single entry point that decides `monitor_record.current_level` (issue
 * #88).
 *
 * This is the highest-risk piece of the whole issue, because three separate
 * paths now influence one column - the sync job's keyword matching, #87's
 * filtering of hits, and #88's classification - and the acceptance floor is
 * that a deployment with the classifier off behaves EXACTLY as it did before
 * #88. Two groups of tests, matching the two halves of the module:
 *
 *   1. The rule itself (`computeEffectiveLevel`), exhaustively, because it is
 *      what a doctor sees and it is pure.
 *   2. The database recompute, for the properties that make it safe to call
 *      from inside any of those three paths: bounded queries, only-what-moved
 *      writes, idempotence, and no invented levels.
 */

function makeClient(options: {
  grouped?: { monitorRecordId: string; level: string }[];
  records?: { id: string; currentLevel: string; aiAttentionLevel: string | null }[];
  updateCount?: number;
}) {
  return {
    monitorMatch: {
      groupBy: jest.fn(async (_args: unknown) => options.grouped ?? []),
    },
    monitorRecord: {
      findMany: jest.fn(async (_args: unknown) => options.records ?? []),
      updateMany: jest.fn(async (_args: unknown) => ({ count: options.updateCount ?? 1 })),
    },
  };
}

type MockClient = ReturnType<typeof makeClient>;

/** The store sees only the two delegates it uses; the cast keeps the mock typed. */
const asLevelClient = (mock: MockClient): LevelClient => mock as unknown as LevelClient;

/** The target level of every `updateMany` call, paired with the ids it named. */
function writesByLevel(mock: MockClient): Map<string, string[]> {
  return new Map(
    mock.monitorRecord.updateMany.mock.calls.map((call) => {
      const args = call[0] as {
        where: { id: { in: string[] } };
        data: { currentLevel: string };
      };
      return [args.data.currentLevel, args.where.id.in];
    }),
  );
}

describe('computeEffectiveLevel', () => {
  it('returns the keyword level when there is no AI level', () => {
    expect(computeEffectiveLevel(['YELLOW'], null)).toBe('YELLOW');
  });

  it('takes the highest of several keyword hits', () => {
    expect(computeEffectiveLevel(['GREEN', 'RED', 'YELLOW'], null)).toBe('RED');
  });

  it('returns UNCLASSIFIED when there is nothing at all', () => {
    expect(computeEffectiveLevel([], null)).toBe('UNCLASSIFIED');
  });

  /** The headline acceptance criterion: AI must never lower a keyword level. */
  it('keeps the keyword level when the AI level is LOWER', () => {
    expect(computeEffectiveLevel(['RED'], 'GREEN')).toBe('RED');
    expect(computeEffectiveLevel(['RED'], 'YELLOW')).toBe('RED');
    expect(computeEffectiveLevel(['YELLOW'], 'GREEN')).toBe('YELLOW');
  });

  /** The other half: AI may raise a level, which is the whole point of #88. */
  it('raises the level when the AI level is HIGHER', () => {
    expect(computeEffectiveLevel(['GREEN'], 'RED')).toBe('RED');
    expect(computeEffectiveLevel(['YELLOW'], 'RED')).toBe('RED');
    expect(computeEffectiveLevel(['GREEN'], 'YELLOW')).toBe('YELLOW');
  });

  it('is unchanged when the AI level equals the keyword level', () => {
    expect(computeEffectiveLevel(['YELLOW', 'GREEN'], 'YELLOW')).toBe('YELLOW');
  });

  /**
   * The case that makes #88 worth having: a report no keyword matched but the
   * classifier understood. Without an AI level it stays UNCLASSIFIED.
   */
  it('uses the AI level alone when no keyword hit survives', () => {
    expect(computeEffectiveLevel([], 'RED')).toBe('RED');
    expect(computeEffectiveLevel([], 'GREEN')).toBe('GREEN');
  });

  it('respects the documented priority order RED > YELLOW > GREEN > UNCLASSIFIED', () => {
    expect(computeEffectiveLevel(['GREEN'], 'YELLOW')).toBe('YELLOW');
    // UNCLASSIFIED is the floor, never a competitor: nothing can be "lower".
    expect(computeEffectiveLevel(['UNCLASSIFIED'], 'GREEN')).toBe('GREEN');
    expect(computeEffectiveLevel(['UNCLASSIFIED'], null)).toBe('UNCLASSIFIED');
  });

  it('does not depend on the order of the levels it is given', () => {
    expect(computeEffectiveLevel(['GREEN', 'RED'], 'YELLOW')).toBe(
      computeEffectiveLevel(['RED', 'GREEN'], 'YELLOW'),
    );
  });
});

describe('recomputeRecordLevels', () => {
  it('writes nothing and reports 0 when every level already agrees', async () => {
    const prisma = makeClient({
      grouped: [
        { monitorRecordId: 'rec1', level: 'YELLOW' },
        { monitorRecordId: 'rec1', level: 'GREEN' },
      ],
      records: [{ id: 'rec1', currentLevel: 'YELLOW', aiAttentionLevel: null }],
    });

    expect(await recomputeRecordLevels(asLevelClient(prisma), ['rec1'])).toBe(0);
    expect(prisma.monitorRecord.updateMany).not.toHaveBeenCalled();
  });

  it('reads only non-filtered hits, so a filtered hit stops contributing', async () => {
    const prisma = makeClient({
      grouped: [],
      records: [{ id: 'rec1', currentLevel: 'RED', aiAttentionLevel: null }],
    });

    await recomputeRecordLevels(asLevelClient(prisma), ['rec1']);

    // The judge's filter is what this WHERE clause is about: a hit the semantic
    // judge filtered stays in monitor_match as evidence but must not keep a
    // level alive on the workbench.
    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledWith({
      by: ['monitorRecordId', 'level'],
      where: { monitorRecordId: { in: ['rec1'] }, semanticFiltered: false },
    });
    expect(writesByLevel(prisma).get('UNCLASSIFIED')).toEqual(['rec1']);
  });

  it('falls back to the AI level when every keyword hit was filtered', async () => {
    const prisma = makeClient({
      grouped: [],
      records: [{ id: 'rec1', currentLevel: 'RED', aiAttentionLevel: 'YELLOW' }],
    });

    await recomputeRecordLevels(asLevelClient(prisma), ['rec1']);

    expect(writesByLevel(prisma).get('YELLOW')).toEqual(['rec1']);
  });

  it('raises a keyword-only record when the classifier found something worse', async () => {
    const prisma = makeClient({
      grouped: [{ monitorRecordId: 'rec1', level: 'GREEN' }],
      records: [{ id: 'rec1', currentLevel: 'GREEN', aiAttentionLevel: 'RED' }],
    });

    expect(await recomputeRecordLevels(asLevelClient(prisma), ['rec1'])).toBe(1);
    expect(writesByLevel(prisma).get('RED')).toEqual(['rec1']);
  });

  /** With the classifier off, ai_attention_level is NULL forever - pre-#88. */
  it('reduces to the keyword level when the AI column is NULL', async () => {
    const prisma = makeClient({
      grouped: [{ monitorRecordId: 'rec1', level: 'YELLOW' }],
      records: [{ id: 'rec1', currentLevel: 'UNCLASSIFIED', aiAttentionLevel: null }],
    });

    await recomputeRecordLevels(asLevelClient(prisma), ['rec1']);

    expect(writesByLevel(prisma).get('YELLOW')).toEqual(['rec1']);
  });

  it('groups records by target level so a batch costs one write per level, not per record', async () => {
    const prisma = makeClient({
      grouped: [
        { monitorRecordId: 'rec1', level: 'RED' },
        { monitorRecordId: 'rec2', level: 'RED' },
        { monitorRecordId: 'rec3', level: 'GREEN' },
      ],
      records: [
        { id: 'rec1', currentLevel: 'UNCLASSIFIED', aiAttentionLevel: null },
        { id: 'rec2', currentLevel: 'UNCLASSIFIED', aiAttentionLevel: null },
        { id: 'rec3', currentLevel: 'UNCLASSIFIED', aiAttentionLevel: null },
      ],
      updateCount: 2,
    });

    const changed = await recomputeRecordLevels(asLevelClient(prisma), ['rec1', 'rec2', 'rec3']);

    // Two levels among three records -> two UPDATEs. The reported count is the
    // DB's, not the number of ids we grouped, so a row deleted concurrently
    // cannot inflate the figure.
    expect(prisma.monitorRecord.updateMany).toHaveBeenCalledTimes(2);
    expect(writesByLevel(prisma)).toEqual(
      new Map([
        ['RED', ['rec1', 'rec2']],
        ['GREEN', ['rec3']],
      ]),
    );
    expect(changed).toBe(4);
  });

  it('visits each record once even when a caller names it several times', async () => {
    const prisma = makeClient({
      grouped: [{ monitorRecordId: 'rec1', level: 'RED' }],
      records: [{ id: 'rec1', currentLevel: 'RED', aiAttentionLevel: null }],
    });

    await recomputeRecordLevels(asLevelClient(prisma), ['rec1', 'rec1', 'rec1']);

    expect(prisma.monitorMatch.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.monitorRecord.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['rec1'] } },
      select: { id: true, currentLevel: true, aiAttentionLevel: true },
    });
  });

  it('is a no-op for an empty list, without touching the database', async () => {
    const prisma = makeClient({});

    expect(await recomputeRecordLevels(asLevelClient(prisma), [])).toBe(0);
    expect(prisma.monitorMatch.groupBy).not.toHaveBeenCalled();
    expect(prisma.monitorRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.monitorRecord.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing for a record that has since been deleted', async () => {
    const prisma = makeClient({ grouped: [{ monitorRecordId: 'gone', level: 'RED' }], records: [] });

    expect(await recomputeRecordLevels(asLevelClient(prisma), ['gone'])).toBe(0);
    expect(prisma.monitorRecord.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pass over the same records writes nothing', async () => {
    const grouped = [{ monitorRecordId: 'rec1', level: 'YELLOW' }];
    const first = makeClient({
      grouped,
      records: [{ id: 'rec1', currentLevel: 'UNCLASSIFIED', aiAttentionLevel: null }],
    });

    expect(await recomputeRecordLevels(asLevelClient(first), ['rec1'])).toBe(1);

    // The row now reads YELLOW, which is what a second pass would compute.
    const second = makeClient({
      grouped,
      records: [{ id: 'rec1', currentLevel: 'YELLOW', aiAttentionLevel: null }],
    });
    expect(await recomputeRecordLevels(asLevelClient(second), ['rec1'])).toBe(0);
    expect(second.monitorRecord.updateMany).not.toHaveBeenCalled();
  });
});
