/**
 * Stable DTOs for issue #13's authorization + audit surfaces: the
 * `GET /api/audit` read endpoint and the role vocabulary shared by the
 * frontend. These mirror apps/api's `AppRole`/`AuditAction` enums and the
 * `audit_log` table (see apps/api/prisma/schema.prisma and docs/auth.md for
 * the authoritative documentation).
 *
 * The audit log is append-only from the API's perspective: rows are written
 * by AuditService for key reads and rules writes, and read here by users with
 * the AUDITOR role. `meta` is a low-sensitivity JSON bag (filters, counts,
 * masked flag, rule semantics) and must never carry patient data, report body
 * text, or credentials.
 */

/**
 * Application role assigned to a user via app_user_access (issue #13).
 * USER_ADMIN (issue #78/#79) manages app_user accounts and app_user_access
 * grants via the user-admin feature, kept separate from SYSTEM_ADMIN.
 */
export type AppRoleDto =
  | 'VIEWER'
  | 'RULE_ADMIN'
  | 'SYSTEM_ADMIN'
  | 'AUDITOR'
  | 'USER_ADMIN';

/**
 * One audited operation. LOGIN is a reserved seam (issue #31) and currently
 * has no trigger point. CONFIG_CHANGE is triggered by notification channel/
 * template writes (issue #54). NOTIFICATION_TEST_SEND (issue #52/#53) is a
 * distinct action from CONFIG_CHANGE - a test-send is a real outbound push,
 * not a configuration edit, and must be independently auditable.
 * NOTIFICATION_RULE_RUN (issue: push rules) is a manual "run now" of a push
 * rule - scheduled runs have no operator, so their audit trail IS the
 * push_log rows and they never write audit_log.
 * USER_CREATE/USER_ROLE_CHANGE/USER_DISABLE/USER_ENABLE/USER_DELETE/
 * USER_PASSWORD_RESET (issue #78/#79) are account and access-grant writes
 * made through the /api/users endpoints (issue #81).
 */
export type AuditActionDto =
  | 'EXAM_LIST'
  | 'EXAM_DETAIL'
  | 'RULE_CREATE'
  | 'RULE_UPDATE'
  | 'RULE_IMPORT'
  | 'CONFIG_CHANGE'
  | 'AUDIT_VIEW'
  | 'LOGIN'
  | 'NOTIFICATION_TEST_SEND'
  | 'NOTIFICATION_RULE_RUN'
  | 'USER_CREATE'
  | 'USER_ROLE_CHANGE'
  | 'USER_DISABLE'
  | 'USER_ENABLE'
  | 'USER_DELETE'
  | 'USER_PASSWORD_RESET';

/** One row of `GET /api/audit`. */
export interface AuditLogDto {
  id: string;
  /** Acting app_user.username; null only if no authenticated identity was available. */
  actorUsername: string | null;
  /** Primary role of the actor at the time of the action. */
  actorRole: AppRoleDto;
  action: AuditActionDto;
  /** High-level resource type, e.g. monitor_record / monitor_rule / audit_log. */
  resourceType: string;
  /** Resource identifier when applicable (e.g. monitor_record.id, rule id). */
  resourceId: string | null;
  /** Department context (record's department / filter value) when applicable. */
  department: string | null;
  /** Low-sensitivity audit context - never patient data / report text / secrets. */
  meta: Record<string, unknown> | null;
  /** Best-effort client IP. */
  ip: string | null;
  /** Request correlation id for joining against API error logs. */
  correlationId: string | null;
  /** ISO 8601 UTC instant. */
  createdAt: string;
}

/** Paginated response envelope for `GET /api/audit`. */
export interface PaginatedAuditLog {
  items: AuditLogDto[];
  total: number;
  page: number;
  pageSize: number;
}
