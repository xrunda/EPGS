import { Prisma } from '@prisma/client';
import { LEVEL_PRIORITY, MonitorLevel } from '@epgs/matching-engine';

/**
 * THE single place `monitor_record.current_level` is decided (issue #88).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Before #88 there was exactly one writer:
 * the sync job, which set `currentLevel` to whatever the keyword engine
 * returned. #87 added a second influence - the semantic judge can remove a hit
 * from the effective set - and #88 adds a third: AI report classification can
 * add a level where no keyword matched at all. Three writers computing a level
 * three ways is how a record ends up showing RED on the workbench and YELLOW in
 * the push summary, and nothing in the codebase would say which was right.
 *
 * So the level is not "set" by anyone any more. Every path calls
 * `recomputeRecordLevels`, which RECONSTRUCTS it from the two durable inputs:
 *
 *   1. the record's EFFECTIVE keyword hits - `monitor_match` rows with
 *      `semanticFiltered = false`. A filtered hit stays in the table (it is
 *      evidence) but stops contributing.
 *   2. the record's current AI level - `monitor_record.ai_attention_level`,
 *      written by the classifier and NULLed whenever the report's content
 *      changes so a stale classification can never keep a level alive.
 *
 * The rule is `LEVEL_PRIORITY` (RED > YELLOW > GREEN > UNCLASSIFIED) applied over
 * the union of those two. Two properties fall out of taking a MAXIMUM rather
 * than a last-writer-wins assignment, and both are acceptance criteria:
 *
 *   - AI can only ever RAISE a level. A record whose keyword hit says YELLOW
 *     stays YELLOW whatever the classifier concludes, including "nothing here".
 *     There is no code path in this file, or reachable from it, that can lower a
 *     keyword-derived level on account of an AI result.
 *   - An AI failure changes nothing. A timeout, an unverifiable evidence
 *     excerpt, an incoherent reply - all of them leave `ai_attention_level` as
 *     it was, so the recomputed level is exactly the keyword-derived one. With
 *     the classifier switched off the column is permanently NULL and this
 *     function reduces to precisely the pre-#88 behaviour.
 *
 * The reverse direction still works: a record whose ONLY level came from the AI
 * drops back to UNCLASSIFIED when its content changes and the classification is
 * cleared, and a record whose keyword hits were all filtered drops to its AI
 * level rather than to UNCLASSIFIED. That is why this recomputes downward as
 * well as upward - and why it is called after every one of those transitions.
 *
 * NOT touched here: firstMatchedAt / lastMatchedAt. Those record when the
 * KEYWORD engine matched, which stays true regardless of what either AI task
 * concludes, and they drive no level and no notification - only the workbench's
 * sort options.
 */

/** The columns this needs. Both `PrismaService` and a transaction client satisfy it. */
export type LevelClient = Prisma.TransactionClient;

/**
 * Reduce the two inputs to one level. Pure, so the rule above can be tested
 * without a database - which matters, because this is the function that decides
 * what a doctor sees.
 *
 * @param keywordLevels levels of the record's non-filtered keyword hits. May
 *                      repeat; may be empty.
 * @param aiLevel       `monitor_record.ai_attention_level`, or null when no
 *                      current classification exists.
 */
export function computeEffectiveLevel(
  keywordLevels: readonly MonitorLevel[],
  aiLevel: MonitorLevel | null,
): MonitorLevel {
  const candidates: MonitorLevel[] = aiLevel === null ? [...keywordLevels] : [...keywordLevels, aiLevel];
  return LEVEL_PRIORITY.find((level) => candidates.includes(level)) ?? 'UNCLASSIFIED';
}

/**
 * Recompute the level of each given record, writing only the ones that moved.
 *
 * Bounded by `recordIds` rather than scanning the table: the two reads are one
 * GROUP BY and one `IN (...)` lookup regardless of how many records are passed,
 * and the writes are one `updateMany` per distinct target level (at most four).
 * A tick therefore costs a fixed number of queries, not one per record.
 *
 * Returns how many records' levels actually changed - the caller's signal that
 * something downstream (the daily push summary counts) will read differently.
 *
 * Safe to call with an empty list and safe to call twice.
 */
export async function recomputeRecordLevels(
  client: LevelClient,
  recordIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(recordIds)];
  if (ids.length === 0) return 0;

  const keywordGroups = await client.monitorMatch.groupBy({
    by: ['monitorRecordId', 'level'],
    where: { monitorRecordId: { in: ids }, semanticFiltered: false },
  });

  const levelsByRecord = new Map<string, MonitorLevel[]>();
  for (const group of keywordGroups) {
    const list = levelsByRecord.get(group.monitorRecordId) ?? [];
    list.push(group.level as MonitorLevel);
    levelsByRecord.set(group.monitorRecordId, list);
  }

  const records = await client.monitorRecord.findMany({
    where: { id: { in: ids } },
    select: { id: true, currentLevel: true, aiAttentionLevel: true },
  });

  // Group the writes by target level so the whole recompute is at most four
  // UPDATEs independent of how many records moved.
  const idsByLevel = new Map<string, string[]>();
  for (const record of records) {
    const level = computeEffectiveLevel(
      levelsByRecord.get(record.id) ?? [],
      record.aiAttentionLevel,
    );
    if (level === record.currentLevel) continue;
    const list = idsByLevel.get(level) ?? [];
    list.push(record.id);
    idsByLevel.set(level, list);
  }

  let changed = 0;
  for (const [level, changedIds] of idsByLevel) {
    const result = await client.monitorRecord.updateMany({
      where: { id: { in: changedIds } },
      data: { currentLevel: level as MonitorLevel },
    });
    changed += result.count;
  }
  return changed;
}
