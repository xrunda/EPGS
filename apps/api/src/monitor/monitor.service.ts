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

  async list(query: ListExamsQueryDto): Promise<PaginatedMonitorExams> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.buildWhere(query);
    const orderBy = this.buildOrderBy(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.monitorRecord.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: MonitorService.LIST_SELECT,
      }),
      this.prisma.monitorRecord.count({ where }),
    ]);

    return {
      items: items.map((row) => toExamDto(row)),
      total,
      page,
      pageSize,
    };
  }

  async getDetail(id: string): Promise<MonitorExamDetailDto> {
    const record = await this.prisma.monitorRecord.findUnique({
      where: { id },
      include: {
        matches: {
          orderBy: [{ matchedAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!record) throw new MonitorRecordNotFoundException(id);
    return toExamDetailDto(record);
  }

  /**
   * Level counts under the SAME filters as the list. Uses a single GROUP BY
   * over current_level rather than five COUNT queries; buckets absent from
   * the result default to 0. Since currentLevel is non-null, every record
   * lands in exactly one bucket, so total == sum(red, yellow, green,
   * unclassified) always holds for the same `where`.
   */
  async summary(query: SummaryQueryDto): Promise<MonitorSummaryDto> {
    const where = this.buildWhere(query);
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

  private buildWhere(query: MonitorFiltersDto): Prisma.MonitorRecordWhereInput {
    const range = resolveDateRange(query.examDateFrom, query.examDateTo);
    return {
      ...(range
        ? {
            examTime: {
              ...(range.gte ? { gte: range.gte } : {}),
              ...(range.lt ? { lt: range.lt } : {}),
            },
          }
        : {}),
      ...(query.department
        ? { department: { equals: query.department, mode: 'insensitive' } }
        : {}),
      ...(query.patientTypeCode ? { patientTypeCode: query.patientTypeCode } : {}),
      ...(query.level ? { currentLevel: query.level } : {}),
      ...(query.examItem ? { examItem: { contains: query.examItem, mode: 'insensitive' } } : {}),
      // q searches patientName OR the keyword snapshot on a matched rule -
      // NOT reportContent/diagnosis (issue #7: 防止无界全文扫描). A record
      // is matched if ANY of its monitor_match rows' keyword contains q.
      ...(query.q
        ? {
            OR: [
              { patientName: { contains: query.q, mode: 'insensitive' } },
              { matches: { some: { keyword: { contains: query.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
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
