import { BadRequestException, Injectable } from '@nestjs/common';
import { MatchField, MatchMode, MonitorLevel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportStagingStore } from './import-staging.store';
import { parseRulesCsv, RawImportRow } from './csv-parser';
import {
  ImportConfirmResult,
  ImportRowError,
  ImportRuleRow,
  ImportValidateResult,
} from '@epgs/shared-types';

const VALID_LEVELS = new Set<string>(Object.values(MonitorLevel));
const VALID_MATCH_FIELDS = new Set<string>(Object.values(MatchField));
const VALID_MATCH_MODES = new Set<string>(Object.values(MatchMode));

interface NormalizedRow {
  line: number;
  keyword: string;
  level: MonitorLevel;
  matchField: MatchField;
  matchMode: MatchMode;
  category: string | null;
  notes: string | null;
}

/**
 * Implements issue #4's two-step CSV import:
 *   1. validate(buffer) - parses + pre-validates, writes nothing, returns
 *      an importToken plus per-row errors/preview so the caller (config
 *      dialog, issue #11) can show a confirmation screen.
 *   2. confirm(token, actorId) - re-validates against the DB state as of
 *      now (rules may have changed since step 1) and writes all valid
 *      rows in a single transaction.
 *
 * Design note: this class purposefully does not accept partial success on
 * confirm - if any previously-valid row now conflicts (e.g. a concurrent
 * create landed between validate and confirm), the whole confirm call
 * fails with a row-level error list rather than silently skipping rows,
 * so the operator always knows exactly what got written.
 */
@Injectable()
export class RulesImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ImportStagingStore,
  ) {}

  validate(buffer: Buffer): ImportValidateResult {
    const { rows, fatalError } = parseRulesCsv(buffer);

    if (fatalError) {
      throw new BadRequestException({
        code: 'IMPORT_FILE_INVALID',
        message: fatalError,
      });
    }

    const errors: ImportRowError[] = [];
    const normalized: NormalizedRow[] = [];
    const seenInFile = new Set<string>();

    for (const row of rows) {
      const rowErrors = this.validateRow(row, seenInFile);
      if (rowErrors.length > 0) {
        errors.push(...rowErrors.map((message) => ({ line: row.line, message })));
        continue;
      }

      const dedupeKey = this.dedupeKey(
        row.keyword.trim(),
        row.level,
        row.matchField,
        row.matchMode ?? 'CONTAINS',
      );
      seenInFile.add(dedupeKey);

      normalized.push({
        line: row.line,
        keyword: row.keyword.trim(),
        level: row.level as MonitorLevel,
        matchField: row.matchField as MatchField,
        matchMode: (row.matchMode as MatchMode | undefined) ?? MatchMode.CONTAINS,
        category: row.category ?? null,
        notes: row.notes ?? null,
      });
    }

    const importToken = this.store.put(normalized as unknown as RawImportRow[]);

    const preview: ImportRuleRow[] = normalized.map((r) => ({
      line: r.line,
      keyword: r.keyword,
      level: r.level,
      matchField: r.matchField,
      matchMode: r.matchMode,
      category: r.category ?? undefined,
      notes: r.notes ?? undefined,
    }));

    return {
      importToken,
      totalRows: rows.length,
      validRows: normalized.length,
      errors,
      preview,
    };
  }

  async confirm(importToken: string, actorId: string): Promise<ImportConfirmResult> {
    const staged = this.store.take(importToken) as unknown as NormalizedRow[] | undefined;
    if (!staged) {
      throw new BadRequestException({
        code: 'IMPORT_TOKEN_INVALID',
        message: 'This import batch was not found or has expired. Please re-validate the file.',
      });
    }
    if (staged.length === 0) {
      throw new BadRequestException({
        code: 'IMPORT_NO_VALID_ROWS',
        message: 'No valid rows to import.',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const createdRuleIds: string[] = [];
      const conflictErrors: ImportRowError[] = [];

      for (const row of staged) {
        const conflict = await tx.monitorRule.findFirst({
          where: {
            isEnabled: true,
            keyword: { equals: row.keyword, mode: 'insensitive' },
            level: row.level,
            matchField: row.matchField,
            matchMode: row.matchMode,
          },
        });

        if (conflict) {
          conflictErrors.push({
            line: row.line,
            message: `Conflicts with existing enabled rule ${conflict.id} (same keyword/level/matchField/matchMode).`,
          });
          continue;
        }

        const created = await tx.monitorRule.create({
          data: {
            keyword: row.keyword,
            level: row.level,
            matchField: row.matchField,
            matchMode: row.matchMode,
            category: row.category,
            notes: row.notes,
            // Issue #87: CSV import deliberately does NOT carry a
            // semanticIntent - the import format is the pre-#87 column set,
            // and an intent is the doctor's own sentence rather than a
            // spreadsheet cell. Imported rules land in the documented
            // "not configured" state and are skipped by the AI judge until
            // someone fills the field in on the rule config screen.
            semanticIntent: null,
            isEnabled: true,
            version: 1,
            ruleGroupId: '00000000-0000-0000-0000-000000000000',
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
        await tx.monitorRule.update({
          where: { id: created.id },
          data: { ruleGroupId: created.id },
        });
        createdRuleIds.push(created.id);
      }

      if (conflictErrors.length > 0) {
        // Fail the whole confirm atomically (transaction rolls back) so a
        // partially-applied import never happens silently - see class doc.
        throw new BadRequestException({
          code: 'IMPORT_CONFIRM_CONFLICT',
          message:
            'One or more rows conflict with existing rules as of confirm time. No rows were written.',
          details: { errors: conflictErrors },
        });
      }

      return { createdCount: createdRuleIds.length, createdRuleIds };
    });
  }

  private validateRow(row: RawImportRow, seenInFile: Set<string>): string[] {
    const errors: string[] = [];

    const keyword = row.keyword?.trim() ?? '';
    if (keyword.length === 0) {
      errors.push('keyword must not be blank');
    } else if (keyword.length > 255) {
      errors.push('keyword exceeds 255 characters');
    }

    const level = row.level?.trim() ?? '';
    if (!VALID_LEVELS.has(level)) {
      errors.push(
        `level "${row.level}" is not a valid MonitorLevel (RED, YELLOW, GREEN, UNCLASSIFIED)`,
      );
    }

    const matchField = row.matchField?.trim() ?? '';
    if (!VALID_MATCH_FIELDS.has(matchField)) {
      errors.push(
        `matchField "${row.matchField}" is not a valid MatchField (FINDINGS, IMPRESSION, REPORT_TEXT, STUDY_DESCRIPTION, OTHER)`,
      );
    }

    const matchMode = row.matchMode?.trim();
    if (matchMode && !VALID_MATCH_MODES.has(matchMode)) {
      errors.push(`matchMode "${row.matchMode}" is not a valid MatchMode (EXACT, CONTAINS, REGEX)`);
    }

    if (errors.length === 0) {
      const key = this.dedupeKey(keyword, level, matchField, matchMode ?? 'CONTAINS');
      if (seenInFile.has(key)) {
        errors.push('duplicate row within this file (same keyword/level/matchField/matchMode)');
      }
    }

    return errors;
  }

  private dedupeKey(keyword: string, level: string, matchField: string, matchMode: string): string {
    return `${keyword.toLowerCase()}::${level}::${matchField}::${matchMode}`;
  }
}
