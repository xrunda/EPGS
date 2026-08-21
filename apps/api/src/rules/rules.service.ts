import { Injectable } from '@nestjs/common';
import { MonitorRule, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules.query.dto';
import { toRuleDto } from './rules.mapper';
import { RuleConflictException } from './errors/rule-conflict.exception';
import { RuleNotFoundException } from './errors/rule-not-found.exception';
import { RuleVersionConflictException } from './errors/rule-version-conflict.exception';
import { PaginatedMonitorRules, MonitorRuleDto } from '@epgs/shared-types';

/** Fields that change matching semantics - editing any of these creates a new versioned row (see schema.prisma doc on MonitorRule.version). */
const SEMANTIC_FIELDS = ['keyword', 'level', 'matchField', 'matchMode'] as const;

@Injectable()
export class RulesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListRulesQueryDto): Promise<PaginatedMonitorRules> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.MonitorRuleWhereInput = {
      ...(query.keyword ? { keyword: { contains: query.keyword, mode: 'insensitive' } } : {}),
      ...(query.level ? { level: query.level } : {}),
      ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
      ...(query.category ? { category: query.category } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.monitorRule.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.monitorRule.count({ where }),
    ]);

    return {
      items: items.map(toRuleDto),
      total,
      page,
      pageSize,
    };
  }

  async getById(id: string): Promise<MonitorRuleDto> {
    const rule = await this.prisma.monitorRule.findUnique({ where: { id } });
    if (!rule) throw new RuleNotFoundException(id);
    return toRuleDto(rule);
  }

  async create(dto: CreateRuleDto, actorUsername?: string): Promise<MonitorRuleDto> {
    const keyword = dto.keyword.trim();
    const matchMode = dto.matchMode ?? 'CONTAINS';
    const isEnabled = dto.isEnabled ?? true;
    // Issue #13: when the caller is authenticated, the server-side username
    // is authoritative (dto.actorId is kept only for backwards-compatible
    // DTO shape and is ignored by the controller).
    const actor = actorUsername ?? dto.actorId;

    // ruleGroupId defaults to this row's own id (see schema doc) - the id
    // isn't known before insert, so this is a create-then-patch pair
    // wrapped in a transaction for atomicity (never leave a row with a
    // placeholder ruleGroupId visible to other queries). The conflict
    // check also runs inside this transaction to shrink (not eliminate -
    // see assertNoConflict's doc comment) the race window between two
    // concurrent creates of the same keyword/level/matchField/matchMode.
    const finalized = await this.prisma.$transaction(async (tx) => {
      if (isEnabled) {
        await this.assertNoConflict(tx, {
          keyword,
          level: dto.level,
          matchField: dto.matchField,
          matchMode,
        });
      }

      const created = await tx.monitorRule.create({
        data: {
          keyword,
          level: dto.level,
          matchField: dto.matchField,
          matchMode,
          category: dto.category ?? null,
          notes: dto.notes ?? null,
          isEnabled,
          version: 1,
          ruleGroupId: '00000000-0000-0000-0000-000000000000',
          createdBy: actor,
          updatedBy: actor,
        },
      });

      return tx.monitorRule.update({
        where: { id: created.id },
        data: { ruleGroupId: created.id },
      });
    });

    return toRuleDto(finalized);
  }

  async update(id: string, dto: UpdateRuleDto, actorUsername?: string): Promise<MonitorRuleDto> {
    // Issue #13: authenticated username is authoritative over dto.actorId.
    const actor = actorUsername ?? dto.actorId;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.monitorRule.findUnique({ where: { id } });
      if (!current) throw new RuleNotFoundException(id);

      // Reject edits against a row that a semantic edit has already
      // superseded within its rule group (i.e. `id` is not the highest
      // `version` row sharing this `ruleGroupId`). Without this check, an
      // operator holding a stale reference to a since-superseded row
      // could still successfully edit it (its own `version` column never
      // changes once it's disabled-by-supersession), silently forking a
      // second, disconnected edit history off the same logical rule
      // instead of being told to reload. This is a version-conflict in
      // spirit (the client's view of "which row is current" is stale)
      // even though `current.version === dto.version` would pass on its
      // own - so it's checked before the version-number comparison below.
      const groupHead = await tx.monitorRule.findFirst({
        where: { ruleGroupId: current.ruleGroupId },
        orderBy: { version: 'desc' },
      });
      if (groupHead && groupHead.id !== current.id) {
        throw new RuleVersionConflictException(id, dto.version, groupHead.version);
      }

      // Optimistic lock, step 1: compare the caller-supplied version
      // against what's actually in the DB right now (inside the
      // transaction, so this read is consistent with the writes below).
      // Step 2 (belt-and-suspenders against a concurrent writer that
      // slips in between this check and the write) is the
      // `where: { version: dto.version }` predicate on the write itself.
      if (current.version !== dto.version) {
        throw new RuleVersionConflictException(id, dto.version, current.version);
      }

      const nextKeyword = dto.keyword !== undefined ? dto.keyword.trim() : current.keyword;
      const nextLevel = dto.level ?? current.level;
      const nextMatchField = dto.matchField ?? current.matchField;
      const nextMatchMode = dto.matchMode ?? current.matchMode;
      const nextCategory = dto.category !== undefined ? dto.category : current.category;
      const nextNotes = dto.notes !== undefined ? dto.notes : current.notes;
      const nextEnabled = dto.isEnabled ?? current.isEnabled;

      const semanticChange = SEMANTIC_FIELDS.some((field) => {
        switch (field) {
          case 'keyword':
            return nextKeyword !== current.keyword;
          case 'level':
            return nextLevel !== current.level;
          case 'matchField':
            return nextMatchField !== current.matchField;
          case 'matchMode':
            return nextMatchMode !== current.matchMode;
          default:
            return false;
        }
      });

      if (nextEnabled) {
        await this.assertNoConflict(
          tx,
          {
            keyword: nextKeyword,
            level: nextLevel,
            matchField: nextMatchField,
            matchMode: nextMatchMode,
          },
          // Exclude the rule's own group from the conflict check - editing
          // a rule (versioned or in-place) must not conflict with its own
          // prior version(s).
          current.ruleGroupId,
        );
      }

      if (!semanticChange) {
        // No matching-semantics change: safe to update the row in place
        // (same id, same ruleGroupId - only enabled/category/notes
        // moved). `version` is still incremented even though the row is
        // reused: MonitorRule.version's contract (schema.prisma) only
        // requires a NEW ROW for semantic changes, it does not forbid
        // bumping the counter on in-place edits - and bumping it here is
        // required for optimistic locking to actually detect concurrent
        // in-place edits (e.g. two operators both disabling/re-noting the
        // same rule from a stale read), not just concurrent semantic edits.
        const result = await tx.monitorRule.updateMany({
          where: { id, version: dto.version },
          data: {
            category: nextCategory,
            notes: nextNotes,
            isEnabled: nextEnabled,
            version: current.version + 1,
            updatedBy: actor,
          },
        });
        if (result.count === 0) {
          // Someone else wrote between our read above and this write.
          const latest = await tx.monitorRule.findUniqueOrThrow({ where: { id } });
          throw new RuleVersionConflictException(id, dto.version, latest.version);
        }
        const updated = await tx.monitorRule.findUniqueOrThrow({ where: { id } });
        return toRuleDto(updated);
      }

      // Semantic change: version instead of overwriting, so historical
      // monitor_match rows keep pointing at the exact rule version that
      // produced them (see schema.prisma + data-dictionary.md).
      const disableResult = await tx.monitorRule.updateMany({
        where: { id, version: dto.version },
        data: { isEnabled: false, updatedBy: actor },
      });
      if (disableResult.count === 0) {
        const latest = await tx.monitorRule.findUniqueOrThrow({ where: { id } });
        throw new RuleVersionConflictException(id, dto.version, latest.version);
      }

      const newVersion = await tx.monitorRule.create({
        data: {
          keyword: nextKeyword,
          level: nextLevel,
          matchField: nextMatchField,
          matchMode: nextMatchMode,
          category: nextCategory,
          notes: nextNotes,
          isEnabled: nextEnabled,
          version: current.version + 1,
          ruleGroupId: current.ruleGroupId,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      return toRuleDto(newVersion);
    });
  }

  /**
   * Global uniqueness policy (see PR description for the "same
   * department" vs "global" business-language ambiguity): among ENABLED
   * rules, (keyword, level, matchField, matchMode) must be unique.
   * Keyword comparison is case-insensitive so e.g. "Ca" and "ca" are
   * treated as the same rule (per issue #4: "'Ca' 默认不区分大小写").
   *
   * Race-safety note: there is no DB-level unique constraint backing this
   * (issue #3's already-merged schema has none, and this issue's scope
   * deliberately avoids modifying it - see PR description). Running the
   * check inside the same transaction as the write narrows, but under
   * Postgres READ COMMITTED does not fully eliminate, the race window
   * between two concurrent requests creating/enabling the same tuple
   * simultaneously. A follow-up issue should add a partial unique index
   * (e.g. `UNIQUE (keyword, level, match_field, match_mode) WHERE
   * is_enabled`) if this race matters in practice.
   */
  private async assertNoConflict(
    tx: Prisma.TransactionClient,
    candidate: { keyword: string; level: string; matchField: string; matchMode: string },
    excludeRuleGroupId?: string,
  ): Promise<void> {
    const conflict = await tx.monitorRule.findFirst({
      where: {
        isEnabled: true,
        keyword: { equals: candidate.keyword, mode: 'insensitive' },
        level: candidate.level as MonitorRule['level'],
        matchField: candidate.matchField as MonitorRule['matchField'],
        matchMode: candidate.matchMode as MonitorRule['matchMode'],
        ...(excludeRuleGroupId ? { ruleGroupId: { not: excludeRuleGroupId } } : {}),
      },
    });

    if (conflict) {
      throw new RuleConflictException(conflict.id);
    }
  }
}
