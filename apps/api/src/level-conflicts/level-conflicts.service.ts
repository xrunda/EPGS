import { Injectable } from '@nestjs/common';
import {
  LEVEL_CONFLICT_DEFAULT_DAYS,
  MonitorLevelConflictListDto,
  MonitorLevelConflictStateDto,
} from '@epgs/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { MonitorExamDetailRow, toLevelConflictHits } from '../monitor/monitor.mapper';
import { MonitorService } from '../monitor/monitor.service';
import { findRecordLevelConflicts } from '../monitor/report-ai.mapper';
import {
  ConflictKeyParts,
  ConflictOccurrence,
  aggregateConflicts,
  parseConflictKey,
} from './level-conflicts.mapper';
import { LevelConflictKeyInvalidException } from './errors/level-conflict-key-invalid.exception';
import { ListLevelConflictsQueryDto } from './dto/list-level-conflicts.query.dto';

/** Days to milliseconds - the window is a plain elapsed-time bound. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Issue #103, admin side: the level-conflict todo list, and the read state on it.
 *
 * WHAT IS COMPUTED, AND WHY IT IS NOT STORED. The conflicts themselves are
 * recomputed here on every request, from the same rows the doctor's drawer
 * reads, through the same `toLevelConflicts` and therefore the same
 * `findLevelConflicts`. Storing them would create a second source of truth that
 * drifts the moment a rule is edited - and there is nothing to gain, because the
 * number of distinct conflicts is a function of the CONFIGURATION (rules x
 * semantics x columns), not of how many reports arrive. The only thing this
 * table stores is the one fact that cannot be recomputed: whether a human has
 * looked at a given conflict.
 *
 * THE QUERY IS PRE-FILTERED, THE RULE IS NOT DUPLICATED. The `where` below
 * narrows to records that could POSSIBLY hold a conflict - active in the window,
 * with an AI contribution to the level, at least one effective keyword hit, and
 * at least one successful attempt. That is a filter on the RECORD, not a
 * re-implementation of the pairing rule in SQL: which hit pairs with which
 * finding is still decided in exactly one place (level-conflict.ts). The
 * alternative - a SQL join expressing the same offsets test - would be a second
 * implementation of the rule, and the two would eventually disagree about what a
 * conflict is.
 *
 * NO PAGINATION, unlike the rules and attention-semantics lists. Those grow with
 * use and are paginated per row; this list is bounded by the configuration, so
 * paginating it would add a page parameter that can only ever be 1.
 */
@Injectable()
export class LevelConflictsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The todo list: every conflict visible in the window, unread first.
   *
   * `read` filters on read state AFTER aggregation, not in SQL - the state is
   * keyed by conflict, while the query is over records, so a SQL filter would
   * silently drop the records behind a read conflict and change its
   * `recordCount`.
   */
  async list(query: ListLevelConflictsQueryDto): Promise<MonitorLevelConflictListDto> {
    const days = query.days ?? LEVEL_CONFLICT_DEFAULT_DAYS;
    const occurrences = await this.collectOccurrences(days);

    // Every read row, unfiltered: the set is bounded by the configuration (one
    // row per conflict an admin has ever touched) and by nothing else, so there
    // is no window to narrow it by - a read decision has no date the record
    // query could join against.
    const readRows = await this.prisma.monitorLevelConflictRead.findMany({
      select: { conflictKey: true, readAt: true },
    });
    const readAtByKey = new Map(readRows.map((row) => [row.conflictKey, row.readAt]));

    const all = aggregateConflicts(occurrences, readAtByKey);
    const items = query.read === undefined ? all : all.filter((item) => (item.readAt !== null) === query.read);

    return {
      items,
      days,
      unreadCount: all.filter((item) => item.readAt === null).length,
    };
  }

  /**
   * Marks a conflict read. IDEMPOTENT: marking an already-read conflict read
   * again just moves the timestamp, which is the truth - the last person to look
   * at it looked at it now.
   *
   * No existence check against the recomputed list. A conflict that has since
   * been fixed by editing a rule is exactly the case where an admin most wants to
   * record "seen it"; refusing the write because the thing no longer appears
   * would lose that, and the row is inert afterwards either way.
   */
  async markRead(conflictKey: string, actor: string | null): Promise<MonitorLevelConflictStateDto> {
    const parts = this.parse(conflictKey);
    const now = new Date();

    const row = await this.prisma.monitorLevelConflictRead.upsert({
      where: { conflictKey },
      create: { conflictKey, ...parts, readAt: now, readBy: actor },
      update: { readAt: now, readBy: actor },
      select: { conflictKey: true, readAt: true },
    });

    return { conflictKey: row.conflictKey, readAt: row.readAt?.toISOString() ?? null };
  }

  /**
   * Marks a conflict unread. IDEMPOTENT in both directions: an unknown key, or
   * one already unread, updates zero rows and still succeeds - the caller asked
   * for a state, and that state now holds.
   *
   * The row is KEPT rather than deleted, with `readAt` set back to null and
   * `readBy` overwritten with this actor. That is the interesting fact later:
   * "the last person to look at this decided it was not worth acting on" is
   * exactly what an admin wants to know about a conflict that keeps reappearing,
   * and deleting the row would throw it away.
   */
  async markUnread(conflictKey: string, actor: string | null): Promise<MonitorLevelConflictStateDto> {
    this.parse(conflictKey);
    await this.prisma.monitorLevelConflictRead.updateMany({
      where: { conflictKey },
      data: { readAt: null, readBy: actor },
    });
    return { conflictKey, readAt: null };
  }

  /** Rejects anything this API could not have issued. See the exception's doc. */
  private parse(conflictKey: string): ConflictKeyParts {
    const parts = parseConflictKey(conflictKey);
    if (parts === null) throw new LevelConflictKeyInvalidException();
    return parts;
  }

  /**
   * Every conflict on every record active in the window.
   *
   * `include` reuses MonitorService.DETAIL_INCLUDE, so this reads byte-for-byte
   * the rows the doctor's drawer reads. The row is therefore wider than this
   * aggregation strictly needs (patient fields and all), and that is the
   * trade-off taken deliberately: the alternative is a second, narrower select
   * that is a second definition of "what the drawer knows", and it would drift
   * the first time either side gained a field.
   *
   * The window is on `lastMatchedAt` - when the keyword path last found
   * something here - rather than on the exam time, because a conflict needs a
   * keyword hit to exist at all, and "nothing has matched this record for ninety
   * days" is what makes a conflict stale.
   */
  private async collectOccurrences(days: number): Promise<ConflictOccurrence[]> {
    const since = new Date(Date.now() - days * DAY_MS);

    const records = await this.prisma.monitorRecord.findMany({
      where: {
        lastMatchedAt: { gte: since },
        // No AI contribution to the level means no second side to disagree with,
        // and it is the same gate the drawer maps under.
        aiAttentionLevel: { not: null },
        // At least one hit the AI did not rule out (#87's story is not this one).
        matches: { some: { semanticFiltered: false } },
        // At least one successful attempt; whether it describes the CURRENT
        // report version is decided by the mapper's attempt selection, not here.
        reportAiAttempts: { some: { outcome: 'OK' } },
      },
      include: MonitorService.DETAIL_INCLUDE,
    });

    const occurrences: ConflictOccurrence[] = [];
    for (const record of records) {
      const row = record as unknown as MonitorExamDetailRow;
      // Unreachable: the where clause above requires a lastMatchedAt inside the
      // window. It is here so the row type can stay honest about the column
      // being nullable rather than asserting it away.
      if (row.lastMatchedAt === null) continue;

      // The un-deduplicated form: this list is keyed by GROUP ids, so two rules
      // configured identically are two separate problems to fix even though a
      // doctor reads them as one sentence.
      const conflicts = findRecordLevelConflicts(
        row.reportAiAttempts,
        row,
        toLevelConflictHits(row.matches),
      );
      for (const conflict of conflicts) {
        occurrences.push({ conflict, seenAt: row.lastMatchedAt });
      }
    }
    return occurrences;
  }
}
