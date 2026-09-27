import { MonitorRecord, Prisma } from '@prisma/client';
import { RuleSnapshot } from '@epgs/matching-engine';
import { hitKey, reclassifyRecord } from './reclassify-record';

/**
 * The per-record logic behind the ops script (`reclassify-once.ts`, CLI) that
 * re-runs matching against the current rule set (issue #96).
 *
 * This spec imports `reclassify-record`, NOT the CLI: the CLI imports AppModule,
 * whose `ConfigModule.forRoot` validation needs a populated `.env` and so fails
 * in CI. Keeping the logic free of Nest is what makes it testable at all - the
 * same reason `monitor/record-level.ts` is a separate module.
 *
 * It is the ONE path that used to assign `monitor_record.current_level` outside
 * `monitor/record-level.ts`, and it did so from the keyword engine's verdict -
 * which since #87 and #88 is no longer the record's level. The two failures
 * that caused are the first two tests below, and they are the reason this file
 * exists: both are silent (nothing errors, nothing logs a warning) and neither
 * is repaired by anything downstream.
 *
 * The rest locks the shape of the fix: re-derive the keyword side from the
 * CURRENT rules, subtract what the judge filtered, and let the AI level raise
 * it - never lower it.
 */

const NOW = new Date('2026-09-26T00:00:00.000Z');

/** Text with no rule keyword in it at all (no Latin letters, so no `Ca`/`NEN`/`SMT` either). */
const QUIET_TEXT = '胃窦黏膜光滑，未见异常。';

function makeRecord(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: 'rec-1',
    reportId: 'TEST-REPLAY-001',
    reportVersion: 1,
    reportContent: QUIET_TEXT,
    diagnosis: '慢性非萎缩性胃炎。',
    currentLevel: 'UNCLASSIFIED',
    aiAttentionLevel: null,
    firstMatchedAt: null,
    lastMatchedAt: null,
    ...overrides,
  } as unknown as MonitorRecord;
}

function rule(overrides: Partial<RuleSnapshot> & { keyword: string }): RuleSnapshot {
  return {
    ruleId: `rule-${overrides.keyword}`,
    ruleVersion: 1,
    level: 'RED',
    matchField: 'REPORT_TEXT',
    matchMode: 'CONTAINS',
    enabled: true,
    ...overrides,
  } as RuleSnapshot;
}

interface FilteredHit {
  ruleId: string;
  matchedField: string;
  keyword: string;
}

function makeTx(filtered: readonly FilteredHit[] = []) {
  return {
    monitorMatch: {
      createMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
      findMany: jest.fn(async (_args: unknown) => [...filtered]),
    },
    monitorRecord: {
      update: jest.fn(async (_args: unknown) => ({})),
    },
  };
}

type MockTx = ReturnType<typeof makeTx>;

/** The store sees only the delegates it uses; the cast keeps the mock typed. */
const asTx = (mock: MockTx): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

/** The level the script tried to write, or undefined when it wrote nothing. */
function levelWritten(mock: MockTx): string | undefined {
  const call = mock.monitorRecord.update.mock.calls[0] as
    | [{ data: { currentLevel: string } }]
    | undefined;
  return call?.[0].data.currentLevel;
}

describe('reclassifyRecord — the two failures issue #96 reproduced', () => {
  it('does NOT demote a level that only the classifier produced', async () => {
    // Before #96 this record - AI-only RED, zero keyword hits - was written
    // back to UNCLASSIFIED: the patient silently left the workbench, and the
    // classifier would never revisit it (its queue is `ai_resolved_at IS NULL`).
    const tx = makeTx();
    const record = makeRecord({ currentLevel: 'RED', aiAttentionLevel: 'RED' });

    const moved = await reclassifyRecord(asTx(tx), record, [rule({ keyword: '癌' })], NOW);

    expect(moved).toBe(false);
    expect(tx.monitorRecord.update).not.toHaveBeenCalled();
  });

  it('does NOT resurrect a hit the semantic judge filtered', async () => {
    // Before #96 the level went back to RED while the match row kept
    // `semanticFiltered = true` - the workbench said RED and the evidence
    // beside it said the hit had been ruled out.
    const keyword = '占位';
    const tx = makeTx([{ ruleId: `rule-${keyword}`, matchedField: 'FINDINGS', keyword }]);
    const record = makeRecord({
      reportContent: '胃窦黏膜光滑，未见明显占位。',
      currentLevel: 'UNCLASSIFIED',
    });

    const moved = await reclassifyRecord(asTx(tx), record, [rule({ keyword })], NOW);

    expect(moved).toBe(false);
    expect(tx.monitorRecord.update).not.toHaveBeenCalled();
    // The hit was still re-derived and offered to the table - it is the LEVEL
    // that must ignore it. `skipDuplicates` is what stops the offered row from
    // clearing the filter on the existing one.
    expect(tx.monitorMatch.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
});

describe('reclassifyRecord — level composition', () => {
  it('counts the hits the judge did NOT filter', async () => {
    const tx = makeTx([{ ruleId: 'rule-占位', matchedField: 'FINDINGS', keyword: '占位' }]);
    const record = makeRecord({ reportContent: '见占位及溃疡。' });

    const moved = await reclassifyRecord(
      asTx(tx),
      record,
      [
        rule({ keyword: '占位', ruleId: 'rule-占位', level: 'RED' }),
        rule({ keyword: '溃疡', ruleId: 'rule-溃疡', level: 'YELLOW' }),
      ],
      NOW,
    );

    expect(moved).toBe(true);
    expect(levelWritten(tx)).toBe('YELLOW');
  });

  it('lets the AI level raise the keyword level', async () => {
    const tx = makeTx();
    const record = makeRecord({
      reportContent: '见溃疡。',
      currentLevel: 'UNCLASSIFIED',
      aiAttentionLevel: 'RED',
    });

    await reclassifyRecord(asTx(tx), record, [rule({ keyword: '溃疡', level: 'YELLOW' })], NOW);

    expect(levelWritten(tx)).toBe('RED');
  });

  it('never lets the AI level lower the keyword level', async () => {
    const tx = makeTx();
    const record = makeRecord({
      reportContent: '见占位。',
      currentLevel: 'YELLOW',
      aiAttentionLevel: 'GREEN',
    });

    await reclassifyRecord(asTx(tx), record, [rule({ keyword: '占位', level: 'RED' })], NOW);

    expect(levelWritten(tx)).toBe('RED');
  });

  it('re-derives from the CURRENT rules, so a disabled rule stops counting', async () => {
    // This is why the fix uses computeEffectiveLevel rather than
    // recomputeRecordLevels: the old match row is still in monitor_match and
    // still `semanticFiltered = false`, so a recompute-from-rows would keep
    // this record RED forever. Re-matching against the current rule set is the
    // script's entire purpose, and that is the input the level must use.
    const tx = makeTx();
    const record = makeRecord({ reportContent: '见占位。', currentLevel: 'RED' });

    const moved = await reclassifyRecord(asTx(tx), record, [], NOW);

    expect(moved).toBe(true);
    expect(levelWritten(tx)).toBe('UNCLASSIFIED');
  });

  it('reports no change when the level is already right (safe to re-run)', async () => {
    // Same inputs as the "counts the hits that were NOT filtered" case, but the
    // record already carries the answer - so a second run writes nothing and
    // the run's `changed` count stays 0.
    const tx = makeTx();
    const record = makeRecord({ reportContent: '见溃疡。', currentLevel: 'YELLOW' });

    const moved = await reclassifyRecord(
      asTx(tx),
      record,
      [rule({ keyword: '溃疡', level: 'YELLOW' })],
      NOW,
    );

    expect(moved).toBe(false);
    expect(tx.monitorRecord.update).not.toHaveBeenCalled();
  });
});

describe('reclassifyRecord — timestamps stay keyword-driven', () => {
  it('stamps lastMatchedAt when the keyword engine matched', async () => {
    const tx = makeTx();
    const record = makeRecord({ reportContent: '见溃疡。' });

    await reclassifyRecord(asTx(tx), record, [rule({ keyword: '溃疡', level: 'YELLOW' })], NOW);

    const call = tx.monitorRecord.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(call[0].data.lastMatchedAt).toEqual(NOW);
    expect(call[0].data.firstMatchedAt).toEqual(NOW);
  });

  it('leaves both alone when nothing matched', async () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z');
    const tx = makeTx();
    const record = makeRecord({
      currentLevel: 'RED',
      firstMatchedAt: earlier,
      lastMatchedAt: earlier,
      reportContent: '见占位。',
    });

    await reclassifyRecord(asTx(tx), record, [], NOW);

    const call = tx.monitorRecord.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(call[0].data.lastMatchedAt).toEqual(earlier);
    expect(call[0].data.firstMatchedAt).toEqual(earlier);
  });
});

describe('hitKey', () => {
  it('separates hits of the same rule in different fields', () => {
    expect(hitKey('r1', 'FINDINGS', '癌')).not.toBe(hitKey('r1', 'IMPRESSION', '癌'));
  });

  it('separates different rules and different keywords', () => {
    expect(hitKey('r1', 'FINDINGS', '癌')).not.toBe(hitKey('r2', 'FINDINGS', '癌'));
    expect(hitKey('r1', 'FINDINGS', '癌')).not.toBe(hitKey('r1', 'FINDINGS', '肿瘤'));
  });

  it('cannot be spoofed by a keyword that contains the separator', () => {
    // The separator is a character no keyword would contain, but the key is
    // built from three parts - so a naive `-` join would let ('a-b','c') and
    // ('a','b-c') collide. This pins that they do not.
    expect(hitKey('a-b', 'FINDINGS', 'c')).not.toBe(hitKey('a', 'FINDINGS', 'b-c'));
  });
});
