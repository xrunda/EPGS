import { AttentionLevel, MatchField, MonitorLevel } from '@prisma/client';
import { MonitorLevelConflictTodoDto } from '@epgs/shared-types';
import { LevelConflict } from '../monitor/level-conflict';

/**
 * Issue #103, admin side: the conflict key, and the aggregation of many records'
 * conflicts into the todo list an admin works from.
 *
 * Kept pure and Prisma-free (the monitor-time / level-conflict pattern) because
 * the key is a CONTRACT, not a formatting detail: it is what an admin's "read"
 * decision is stored against, so building it and parsing it must agree exactly,
 * and a change to either has to be visible in a diff of this file alone. The
 * parse side doubles as the write path's validation - a key that does not parse
 * is rejected rather than stored as an anonymous row.
 *
 * The key is `ruleGroupId:semanticGroupId:field:keywordLevel:aiLevel`, and every
 * one of those five parts is load-bearing:
 *
 *  - GROUP ids, not the versioned rule/semantic rows. Those are immutable and
 *    versioned, so a version id would make every re-wording of a rule look like
 *    a brand new problem - an admin would fix a conflict, watch it disappear,
 *    and see it return the next time someone touched the wording.
 *  - `field`, because one rule can hit both reportContent and diagnosis and
 *    those are two different places in the report. Collapsing them would let one
 *    read decision hide a second, unrelated disagreement.
 *  - Both LEVELS, because re-colouring either side is a different
 *    disagreement with a different answer, and it should come back unread.
 */

const SEPARATOR = ':';

/** A parsed conflict key. The service writes these back as denormalized columns. */
export interface ConflictKeyParts {
  ruleGroupId: string;
  semanticGroupId: string;
  field: MatchField;
  keywordLevel: MonitorLevel;
  aiLevel: AttentionLevel;
}

/** What the aggregation needs from one record's conflicts. */
export interface ConflictOccurrence {
  conflict: LevelConflict;
  /** The record's own "most recent activity", used to rank the todo. */
  seenAt: Date;
}

/**
 * The identity of one conflict. `LevelConflict` carries exactly the five parts
 * and nothing else, so this cannot be called with a mismatched tuple.
 */
export function buildConflictKey(conflict: LevelConflict): string {
  return [
    conflict.ruleGroupId,
    conflict.semanticGroupId,
    conflict.field,
    conflict.keywordLevel,
    // The AI side. `LevelConflict` calls it `semanticLevel` because that is what
    // it means to a doctor ("the level this finding asked for"); the key calls it
    // `aiLevel` because that is which SIDE of the disagreement it is. One value,
    // two names for two audiences - renamed here rather than in the key's
    // grammar, which is a wire format.
    conflict.semanticLevel,
  ].join(SEPARATOR);
}

/**
 * Parses a key back, or null when it is not one this API could have issued.
 *
 * Null on EVERY failure rather than a partial result: the caller turns it into a
 * 400, and a half-understood key must never reach the database as a row. The
 * enum membership checks are what make this more than a shape check - they are
 * the only thing stopping `...:PURPLE:PURPLE` from being stored.
 */
export function parseConflictKey(key: string): ConflictKeyParts | null {
  const parts = key.split(SEPARATOR);
  if (parts.length !== 5) return null;

  const [ruleGroupId, semanticGroupId, field, keywordLevel, aiLevel] = parts;
  if (!isUuid(ruleGroupId) || !isUuid(semanticGroupId)) return null;
  if (!isMatchField(field)) return null;
  if (!isMonitorLevel(keywordLevel)) return null;
  if (!isAttentionLevel(aiLevel)) return null;

  return { ruleGroupId, semanticGroupId, field, keywordLevel, aiLevel };
}

/**
 * Folds every matching record's conflicts into one entry per key.
 *
 * Ordering is UNREAD FIRST, then most recently seen. Unread-first is the whole
 * point of the list - a read entry is one an admin has already dealt with, and
 * burying it is not the same as hiding it (the `read` filter does that on
 * request). Within each group the tie-break is the key, so two entries seen at
 * the same instant still come back in a stable order rather than in whatever
 * order the database happened to return.
 *
 * `readAtByKey` is the read state, passed in rather than looked up here so this
 * stays pure. A key with no entry - or one whose value is null - is unread.
 */
export function aggregateConflicts(
  occurrences: readonly ConflictOccurrence[],
  readAtByKey: ReadonlyMap<string, Date | null>,
): MonitorLevelConflictTodoDto[] {
  const byKey = new Map<string, { conflict: LevelConflict; count: number; lastSeenAt: Date }>();

  for (const { conflict, seenAt } of occurrences) {
    const key = buildConflictKey(conflict);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { conflict, count: 1, lastSeenAt: seenAt });
      continue;
    }
    existing.count += 1;
    if (seenAt.getTime() > existing.lastSeenAt.getTime()) existing.lastSeenAt = seenAt;
  }

  return [...byKey.entries()]
    .map(([conflictKey, entry]) => ({
      conflictKey,
      keyword: entry.conflict.keyword,
      keywordLevel: entry.conflict.keywordLevel,
      semanticName: entry.conflict.semanticName,
      semanticLevel: entry.conflict.semanticLevel,
      field: entry.conflict.field,
      recordCount: entry.count,
      lastSeenAt: entry.lastSeenAt.toISOString(),
      readAt: readAtByKey.get(conflictKey)?.toISOString() ?? null,
    }))
    .sort(compareTodos);
}

/** Unread first, then most recently seen, then by key. See aggregateConflicts. */
function compareTodos(a: MonitorLevelConflictTodoDto, b: MonitorLevelConflictTodoDto): number {
  const aRead = a.readAt !== null;
  const bRead = b.readAt !== null;
  if (aRead !== bRead) return aRead ? 1 : -1;

  const bySeen = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  if (bySeen !== 0) return bySeen;

  return compareText(a.conflictKey, b.conflictKey);
}

/**
 * Code-unit comparison, not locale collation - the same reasoning as
 * level-conflict.ts's comparator: the order must not depend on the ICU data the
 * process was built with, and the keys are ASCII anyway.
 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Canonical UUID shape (any version/variant - these ids come from uuid()). */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/*
 * Enum membership, one predicate per enum rather than a generic helper.
 *
 * Prisma's enum objects are plain string maps at runtime, so a generic
 * `Object.values(E).includes(value)` would work - but TypeScript cannot carry the
 * narrowing back through a generic, and the whole value of parsing here is that
 * the CALLER gets `MatchField`/`MonitorLevel`/`AttentionLevel` rather than
 * `string`. The three predicates are what makes the returned `ConflictKeyParts`
 * the enum types the database columns expect.
 */
function isMatchField(value: string): value is MatchField {
  return Object.values(MatchField).includes(value as MatchField);
}

function isMonitorLevel(value: string): value is MonitorLevel {
  return Object.values(MonitorLevel).includes(value as MonitorLevel);
}

function isAttentionLevel(value: string): value is AttentionLevel {
  return Object.values(AttentionLevel).includes(value as AttentionLevel);
}
