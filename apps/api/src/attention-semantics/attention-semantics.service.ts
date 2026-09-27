import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAttentionSemanticDto } from './dto/create-attention-semantic.dto';
import { UpdateAttentionSemanticDto } from './dto/update-attention-semantic.dto';
import { ListAttentionSemanticsQueryDto } from './dto/list-attention-semantics.query.dto';
import { ImportDefaultsDto } from './dto/import-defaults.dto';
import { toAttentionSemanticDto } from './attention-semantics.mapper';
import { DEFAULT_ATTENTION_SEMANTICS } from './defaults';
import { AttentionSemanticConflictException } from './errors/attention-semantic-conflict.exception';
import { AttentionSemanticNotFoundException } from './errors/attention-semantic-not-found.exception';
import { AttentionSemanticVersionConflictException } from './errors/attention-semantic-version-conflict.exception';
import {
  AttentionSemanticDto,
  ImportAttentionSemanticsResult,
  PaginatedAttentionSemantics,
} from '@epgs/shared-types';

/**
 * Fields that change what a semantic MEANS - editing any of these creates a new
 * versioned row rather than overwriting (see schema.prisma doc on
 * AttentionSemantic.version).
 *
 * `attentionLevel` counts, and is the most important member: it is the colour a
 * finding inherits. Re-colouring in place would retroactively change what past
 * findings appear to have been - a report judged YELLOW would read as if it had
 * always been RED, or worse, the reverse.
 *
 * `name` counts too, even though the model never reads it: it is the label a
 * doctor sees on a finding, and an auditor's handle on the entry.
 */
const SEMANTIC_FIELDS = ['name', 'description', 'attentionLevel'] as const;

@Injectable()
export class AttentionSemanticsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAttentionSemanticsQueryDto): Promise<PaginatedAttentionSemantics> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.AttentionSemanticWhereInput = {
      ...(query.name ? { name: { contains: query.name, mode: 'insensitive' } } : {}),
      ...(query.attentionLevel ? { attentionLevel: query.attentionLevel } : {}),
      ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
    };

    // Newest-edited first, ALL versions included - the same shape as
    // /api/rules. A superseded version shows up as a disabled row rather than
    // disappearing, so an operator who edits wording can see that the previous
    // one is now off instead of wondering where it went. Old rows are
    // distinguishable by `version` and `semanticGroupId`.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.attentionSemantic.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attentionSemantic.count({ where }),
    ]);

    return {
      items: items.map(toAttentionSemanticDto),
      total,
      page,
      pageSize,
    };
  }

  async getById(id: string): Promise<AttentionSemanticDto> {
    const semantic = await this.prisma.attentionSemantic.findUnique({ where: { id } });
    if (!semantic) throw new AttentionSemanticNotFoundException(id);
    return toAttentionSemanticDto(semantic);
  }

  async create(
    dto: CreateAttentionSemanticDto,
    actorUsername?: string,
  ): Promise<AttentionSemanticDto> {
    const name = dto.name.trim();
    const description = dto.description.trim();
    const isEnabled = dto.isEnabled ?? true;
    const actor = actorUsername ?? dto.actorId;

    // semanticGroupId defaults to this row's own id, which is not known before
    // insert - hence the create-then-patch pair inside one transaction, so a
    // placeholder group id is never visible to another query. Identical to
    // RulesService.create, and for the same reason.
    const finalized = await this.prisma.$transaction(async (tx) => {
      if (isEnabled) {
        await this.assertNoNameConflict(tx, name);
      }

      const created = await tx.attentionSemantic.create({
        data: {
          name,
          description,
          attentionLevel: dto.attentionLevel,
          isEnabled,
          version: 1,
          semanticGroupId: '00000000-0000-0000-0000-000000000000',
          createdBy: actor,
          updatedBy: actor,
        },
      });

      return tx.attentionSemantic.update({
        where: { id: created.id },
        data: { semanticGroupId: created.id },
      });
    });

    return toAttentionSemanticDto(finalized);
  }

  async update(
    id: string,
    dto: UpdateAttentionSemanticDto,
    actorUsername?: string,
  ): Promise<AttentionSemanticDto> {
    const actor = actorUsername ?? dto.actorId;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.attentionSemantic.findUnique({ where: { id } });
      if (!current) throw new AttentionSemanticNotFoundException(id);

      // Reject edits against a row a semantic edit has already superseded
      // (i.e. `id` is not the highest version in its group). Without this, an
      // operator holding a stale reference could edit a since-superseded row -
      // whose own `version` never changes once it is disabled - and fork a
      // second, disconnected edit history off the same logical semantic instead
      // of being told to reload. Checked BEFORE the version comparison because
      // `current.version === dto.version` would pass on its own here.
      const groupHead = await tx.attentionSemantic.findFirst({
        where: { semanticGroupId: current.semanticGroupId },
        orderBy: { version: 'desc' },
      });
      if (groupHead && groupHead.id !== current.id) {
        throw new AttentionSemanticVersionConflictException(id, dto.version, groupHead.version);
      }

      // Optimistic lock, step 1: compare the caller's version against the DB.
      // Step 2 is the `where: { id, version }` predicate on the writes below,
      // which closes the window between this read and the write.
      if (current.version !== dto.version) {
        throw new AttentionSemanticVersionConflictException(id, dto.version, current.version);
      }

      const nextName = dto.name !== undefined ? dto.name.trim() : current.name;
      const nextDescription =
        dto.description !== undefined ? dto.description.trim() : current.description;
      const nextLevel = dto.attentionLevel ?? current.attentionLevel;
      const nextEnabled = dto.isEnabled ?? current.isEnabled;

      // Driven off SEMANTIC_FIELDS rather than three inline comparisons so that
      // adding a field to that list and forgetting to compare it here is
      // impossible to do silently.
      const semanticChange = SEMANTIC_FIELDS.some((field) => {
        switch (field) {
          case 'name':
            return nextName !== current.name;
          case 'description':
            return nextDescription !== current.description;
          case 'attentionLevel':
            return nextLevel !== current.attentionLevel;
          default:
            return false;
        }
      });

      if (nextEnabled) {
        await this.assertNoNameConflict(tx, nextName, current.semanticGroupId);
      }

      if (!semanticChange) {
        // Only isEnabled moved: edit in place. `version` is still bumped, as in
        // RulesService - the schema requires a NEW ROW for semantic changes, it
        // does not forbid the counter moving on an in-place edit, and without
        // it two operators disabling the same semantic from a stale read would
        // both succeed.
        const result = await tx.attentionSemantic.updateMany({
          where: { id, version: dto.version },
          data: {
            isEnabled: nextEnabled,
            version: current.version + 1,
            updatedBy: actor,
          },
        });
        if (result.count === 0) {
          const latest = await tx.attentionSemantic.findUniqueOrThrow({ where: { id } });
          throw new AttentionSemanticVersionConflictException(id, dto.version, latest.version);
        }
        return toAttentionSemanticDto(
          await tx.attentionSemantic.findUniqueOrThrow({ where: { id } }),
        );
      }

      // Semantic change: version instead of overwriting, so a historical
      // monitor_report_ai_match keeps pointing at the exact wording (and colour)
      // that was in force when the report was judged.
      const disableResult = await tx.attentionSemantic.updateMany({
        where: { id, version: dto.version },
        data: { isEnabled: false, updatedBy: actor },
      });
      if (disableResult.count === 0) {
        const latest = await tx.attentionSemantic.findUniqueOrThrow({ where: { id } });
        throw new AttentionSemanticVersionConflictException(id, dto.version, latest.version);
      }

      const newVersion = await tx.attentionSemantic.create({
        data: {
          name: nextName,
          description: nextDescription,
          attentionLevel: nextLevel,
          isEnabled: nextEnabled,
          version: current.version + 1,
          semanticGroupId: current.semanticGroupId,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      return toAttentionSemanticDto(newVersion);
    });
  }

  /**
   * Load the preset templates (issue #88).
   *
   * NOTHING HERE RUNS AUTOMATICALLY. No migration and no seed writes medical
   * semantics - a hospital gets AI semantics only by calling this, and the
   * audit row records who did. That is the owner's decision, and it is what
   * makes "the classifier reports NO_SEMANTICS" an honest state rather than a
   * failure.
   *
   * IDEMPOTENT, and deliberately conservative about existing entries. For each
   * preset, matched by name among ENABLED semantics:
   *   - absent                    -> created (version 1)
   *   - present, identical text   -> skipped, nothing written
   *   - present, different text   -> skipped by default; re-versioned only when
   *                                  `overwriteExisting` is set
   * A button press must never silently re-colour a meaning a doctor already
   * reviewed, so overwriting is opt-in and its result is reported per count.
   *
   * Runs in ONE transaction: a half-imported set would be a configuration
   * nobody chose.
   */
  async importDefaults(
    dto: ImportDefaultsDto,
    actorUsername?: string,
  ): Promise<ImportAttentionSemanticsResult> {
    const actor = actorUsername ?? dto.actorId;
    const overwrite = dto.overwriteExisting ?? false;

    return this.prisma.$transaction(async (tx) => {
      let createdCount = 0;
      let skippedCount = 0;
      let updatedCount = 0;
      const semanticIds: string[] = [];

      for (const preset of DEFAULT_ATTENTION_SEMANTICS) {
        const existing = await tx.attentionSemantic.findFirst({
          where: { isEnabled: true, name: { equals: preset.name, mode: 'insensitive' } },
          orderBy: { version: 'desc' },
        });

        if (existing) {
          const identical =
            existing.description === preset.description &&
            existing.attentionLevel === preset.attentionLevel;

          if (identical || !overwrite) {
            skippedCount += 1;
            semanticIds.push(existing.id);
            continue;
          }

          // Opt-in overwrite: same versioning path as a manual edit, so the
          // hospital's previous wording stays in the table and any past finding
          // that used it is still traceable.
          await tx.attentionSemantic.update({
            where: { id: existing.id },
            data: { isEnabled: false, updatedBy: actor },
          });
          const next = await tx.attentionSemantic.create({
            data: {
              name: preset.name,
              description: preset.description,
              attentionLevel: preset.attentionLevel,
              isEnabled: true,
              version: existing.version + 1,
              semanticGroupId: existing.semanticGroupId,
              createdBy: actor,
              updatedBy: actor,
            },
          });
          updatedCount += 1;
          semanticIds.push(next.id);
          continue;
        }

        const created = await tx.attentionSemantic.create({
          data: {
            name: preset.name,
            description: preset.description,
            attentionLevel: preset.attentionLevel,
            isEnabled: true,
            version: 1,
            semanticGroupId: '00000000-0000-0000-0000-000000000000',
            createdBy: actor,
            updatedBy: actor,
          },
        });
        const anchored = await tx.attentionSemantic.update({
          where: { id: created.id },
          data: { semanticGroupId: created.id },
        });
        createdCount += 1;
        semanticIds.push(anchored.id);
      }

      return { createdCount, skippedCount, updatedCount, semanticIds };
    });
  }

  /**
   * Among ENABLED semantics, `name` must be unique (case-insensitive, trimmed).
   *
   * Same policy and the same caveat as RulesService.assertNoConflict: there is
   * no DB-level unique index behind this, so running it in the same transaction
   * as the write narrows but does not eliminate the race between two concurrent
   * creators under READ COMMITTED. A partial unique index
   * (`UNIQUE (lower(name)) WHERE is_enabled`) would close it and is the right
   * follow-up if this ever matters in practice; it is out of #88's scope.
   */
  private async assertNoNameConflict(
    tx: Prisma.TransactionClient,
    name: string,
    excludeSemanticGroupId?: string,
  ): Promise<void> {
    const conflict = await tx.attentionSemantic.findFirst({
      where: {
        isEnabled: true,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeSemanticGroupId
          ? { semanticGroupId: { not: excludeSemanticGroupId } }
          : {}),
      },
    });

    if (conflict) {
      throw new AttentionSemanticConflictException(conflict.id);
    }
  }
}
