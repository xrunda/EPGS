import { Injectable } from '@nestjs/common';
import { MonitorLevel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListExamsQueryDto } from './dto/list-exams.query.dto';
import { SummaryQueryDto } from './dto/summary.query.dto';
import { MonitorFiltersDto } from './dto/monitor-filters.query.dto';
import { MonitorRecordNotFoundException } from './errors/monitor-record-not-found.exception';
import { resolveDateRange } from './monitor-time';
import { toExamDetailDto, toExamDto } from './monitor.mapper';
import { MonitorExamDetailDto, MonitorSummaryDto, PaginatedMonitorExams } from '@epgs/shared-types';
import { buildDepartmentScopeWhere, maskExamDetail, maskExamRow } from '../access/data-scope';

/** Issue #13 query options: data-scope restriction + patient-data masking. */
export interface MonitorQueryOptions {
  /** Authorized department names; empty = all departments. */
  scope?: string[];
  /** True when the caller lacks patientDetail rights (mask HIGH-sensitivity fields). */
  maskPatient?: boolean;
}

/**
 * The department condition = authorized scope AND the caller's own filter,
 * merged into one Prisma field filter. A scoped user filtering for a
 * department outside their scope gets no rows (never a leak); with no scope
 * the result is the pre-#13 `{ equals, mode: 'insensitive' }` shape.
 */
function buildDepartmentWhere(
  requested?: string,
  scope?: string[],
): Prisma.StringNullableFilter | undefined {
  if (scope?.length && requested) {
    return { in: scope, equals: requested, mode: 'insensitive' };
  }
  if (scope?.length) {
    return { in: scope };
  }
  if (requested) {
    return { equals: requested, mode: 'insensitive' };
  }
  return undefined;
}

/**
 * Read-only monitor workbench queries (issue #7): the list, the detail
 * snapshot, and the level summary. No writes - the only mutation these
 * endpoints could ever perform is none. reportContent/diagnosis are never
 * selected in list queries (see LIST_SELECT), so they cannot leak into the
 * list response even by accident; they are served only by the detail
 * endpoint.
 */
@Injectable()
export class MonitorService {
  constructor(private readonly prisma: PrismaService) {}

  /** List-display fields only - deliberately excludes reportContent/diagnosis. */
  private static readonly LIST_SELECT = {
    id: true,
    patientName: true,
    department: true,
    bedNo: true,
    patientTypeCode: true,
    patientTypeName: true,
    examItem: true,
    examTime: true,
    currentLevel: true,
    matches: {
      select: { keyword: true, matchedAt: true },
      // Ascending so distinctKeywords (first-appearance order) == earliest-match order.
      orderBy: [{ matchedAt: 'asc' }, { id: 'asc' }],
    },
  } as const satisfies Prisma.MonitorRecordSelect;

  private static readonly LEVEL_KEYS: Record<MonitorLevel, keyof Omit<MonitorSummaryDto, 'total'>> =
    {
      RED: 'red',
      YELLOW: 'yellow',
      GREEN: 'green',
      UNCLASSIFIED: 'unclassified',
    };

  /** Detail hit evidence + rule provenance (issue #8) - shared by both lookup paths. */
  private static readonly DETAIL_INCLUDE = {
    matches: {
      orderBy: [{ matchedAt: 'asc' }, { id: 'asc' }],
      // Issue #8: each hit carries the exact rule version that produced
      // it (ruleId is a scalar on the match row; version lives on the
      // versioned, never-deleted rule). list() never needs this - only
      // the detail endpoint surfaces hit evidence.
      include: { rule: { select: { version: true } } },
    },
  } as const satisfies Prisma.MonitorRecordInclude;

  async list(query: ListExamsQueryDto, opts?: MonitorQueryOptions): Promise<PaginatedMonitorExams> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.buildWhere(query, opts?.scope);
    const orderBy = this.buildOrderBy(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.monitorRecord.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: MonitorService.LIST_SELECT,
      }),
      this.prisma.monitorRecord.count({ where }),
    ]);

    const items = rows.map((row) => toExamDto(row));
    const masked = opts?.maskPatient ?? false;
    return {
      items: masked ? items.map(maskExamRow) : items,
      total,
      page,
      pageSize,
      // Present ONLY when the server masked for this caller (issue #13) - an
      // unmasked response is byte-identical to pre-#13, so existing clients
      // are unaffected.
      ...(masked ? { dataAccess: { masked: true } } : {}),
    };
  }

  async getDetail(id: string, opts?: MonitorQueryOptions): Promise<MonitorExamDetailDto> {
    // Horizontal-escalation guard (issue #13): when the caller is scoped,
    // the lookup is narrowed to their departments, so an out-of-scope id
    // resolves to "not found" (404) rather than 403 - it never reveals that
    // the record exists.
    const scopeWhere = buildDepartmentScopeWhere(opts?.scope);
    const record =
      scopeWhere.department !== undefined
        ? await this.prisma.monitorRecord.findFirst({
            where: { id, ...scopeWhere },
            include: MonitorService.DETAIL_INCLUDE,
          })
        : await this.prisma.monitorRecord.findUnique({
            where: { id },
            include: MonitorService.DETAIL_INCLUDE,
          });
    if (!record) throw new MonitorRecordNotFoundException(id);
    const dto = toExamDetailDto(record);
    return opts?.maskPatient ? maskExamDetail(dto) : dto;
  }

  /**
   * Level counts under the SAME filters as the list. Uses a single GROUP BY
   * over current_level rather than five COUNT queries; buckets absent from
   * the result default to 0. Since currentLevel is non-null, every record
   * lands in exactly one bucket, so total == sum(red, yellow, green,
   * unclassified) always holds for the same `where`.
   */
  async summary(query: SummaryQueryDto, opts?: MonitorQueryOptions): Promise<MonitorSummaryDto> {
    // Counts are not patient-identifying by themselves (aggregate only), so
    // summary never masks - it only honors the department scope.
    const where = this.buildWhere(query, opts?.scope);
    const groups = await this.prisma.monitorRecord.groupBy({
      by: ['currentLevel'],
      where,
      _count: { _all: true },
    });

    const result: MonitorSummaryDto = { total: 0, red: 0, yellow: 0, green: 0, unclassified: 0 };
    for (const group of groups) {
      const key = MonitorService.LEVEL_KEYS[group.currentLevel];
      const count = group._count._all;
      result[key] = count;
      result.total += count;
    }
    return result;
  }

  private buildWhere(query: MonitorFiltersDto, scope?: string[]): Prisma.MonitorRecordWhereInput {
    const range = resolveDateRange(query.examDateFrom, query.examDateTo);
    // Department = scope (issue #13) AND the caller's own department filter,
    // merged into one field condition so the hard authorization boundary is
    // never widened by a filter param: a scoped user asking for a department
    // outside their scope gets no rows, never a leak. When there is no scope
    // the condition is byte-identical to pre-#13 (spec-stable).
    const department = buildDepartmentWhere(query.department, scope);
    return {
      ...(department ? { department } : {}),
      ...(range
        ? {
            examTime: {
              ...(range.gte ? { gte: range.gte } : {}),
              ...(range.lt ? { lt: range.lt } : {}),
            },
          }
        : {}),
      ...(query.patientTypeCode ? { patientTypeCode: query.patientTypeCode } : {}),
      ...(query.level ? { currentLevel: query.level } : {}),
      ...(query.examItem ? { examItem: { contains: query.examItem, mode: 'insensitive' } } : {}),
      // patientName and keyword are independent filters combined by AND
      // (both clauses on the same top-level object) - NOT reportContent/
      // diagnosis (issue #7: 防止无界全文扫描). keyword matches if ANY of
      // the record's monitor_match rows carries that exact keyword.
      ...(query.patientName
        ? { patientName: { contains: query.patientName, mode: 'insensitive' } }
        : {}),
      ...(query.keyword ? { matches: { some: { keyword: query.keyword } } } : {}),
    };
  }

  /**
   * Default order: examTime desc (nulls last), ties broken by
   * currentLevel ASC - the PG enum order RED < YELLOW < GREEN <
   * UNCLASSIFIED makes ASC render RED-first, which is the issue #7
   * tie-break. id is the final stable tie-break so pagination never skips
   * or repeats rows. Custom sort columns get the caller's sortDir + id
   * tie-break (nulls follow Postgres defaults for those columns).
   */
  private buildOrderBy(query: ListExamsQueryDto): Prisma.MonitorRecordOrderByWithRelationInput[] {
    const dir = query.sortDir ?? 'desc';
    switch (query.sortBy ?? 'examTime') {
      case 'currentLevel':
        return [{ currentLevel: dir }, { id: 'asc' }];
      case 'patientName':
        return [{ patientName: dir }, { id: 'asc' }];
      case 'firstMatchedAt':
        return [{ firstMatchedAt: dir }, { id: 'asc' }];
      case 'lastMatchedAt':
        return [{ lastMatchedAt: dir }, { id: 'asc' }];
      case 'examTime':
      default:
        return [{ examTime: { sort: dir, nulls: 'last' } }, { currentLevel: 'asc' }, { id: 'asc' }];
    }
  }
}
