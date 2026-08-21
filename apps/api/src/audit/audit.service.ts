import { Injectable } from '@nestjs/common';
import { AuditAction, AppRole, AuditLog, Prisma } from '@prisma/client';
import { AuditLogDto, PaginatedAuditLog } from '@epgs/shared-types';
import { AppLoggerService } from '../common/logger/app-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Input for recording one audit row. `meta` is a LOW-sensitivity JSON bag
 * (filters, counts, masked flag, rule semantics) and MUST NEVER contain
 * patient data, report body text, or credentials - the log-sanitization spec
 * enforces this against the whole source tree. `actorUsername`/`actorRole`
 * null (e.g. no access grant) simply skips the write.
 */
export interface AuditRecordInput {
  action: AuditAction;
  actorUsername: string | null;
  actorRole: AppRole | null;
  resourceType: string;
  resourceId?: string | null;
  department?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  correlationId?: string | null;
}

export interface AuditListQuery {
  action?: AuditAction;
  actorUsername?: string;
  department?: string;
  page: number;
  pageSize: number;
}

/**
 * Append-only audit trail (issue #13). Writes are fail-open: a DB error
 * during `record` is logged (sanitized, with correlationId) and swallowed so
 * it never turns a business read into a 500 - authorization itself is
 * fail-closed (RolesGuard), audit is best-effort on top.
 */
@Injectable()
export class AuditService {
  private readonly logger = new AppLoggerService();

  constructor(private readonly prisma: PrismaService) {
    this.logger.setContext('AuditService');
  }

  /** Best-effort, sanitized append. Never throws. */
  async record(input: AuditRecordInput): Promise<void> {
    if (!input.actorUsername || !input.actorRole) return;
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUsername: input.actorUsername,
          actorRole: input.actorRole,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          department: input.department ?? null,
          meta: (input.meta ?? {}) as Prisma.InputJsonValue,
          ip: input.ip ?? null,
          correlationId: input.correlationId ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `audit record write failed: action=${input.action} actor=${input.actorUsername} (correlationId=${input.correlationId ?? 'unknown'}) ${(error as Error).message}`,
        input.correlationId ?? undefined,
      );
    }
  }

  /** Paginated, newest-first read for GET /api/audit. */
  async list(query: AuditListQuery): Promise<PaginatedAuditLog> {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.actorUsername) {
      where.actorUsername = { contains: query.actorUsername, mode: 'insensitive' };
    }
    if (query.department) {
      where.department = { equals: query.department, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map(toAuditLogDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    actorUsername: row.actorUsername,
    actorRole: row.actorRole,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    department: row.department,
    meta: (row.meta ?? null) as Record<string, unknown> | null,
    ip: row.ip,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}
