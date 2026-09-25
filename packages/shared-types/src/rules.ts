/**
 * Stable DTOs for the monitor_rule CRUD API (issue #4).
 *
 * These mirror apps/api's Prisma `MonitorRule` model at the wire level so
 * apps/web (issue #11's config dialog) and any other consumer can share a
 * single type definition instead of hand-duplicating the shape. See
 * apps/api/prisma/schema.prisma and docs/data-dictionary.md for the
 * authoritative field-level documentation - this file only re-states the
 * shapes needed for HTTP request/response bodies.
 */

/** Attention level assigned to a rule. Mirrors Prisma's MonitorLevel enum. */
export type MonitorLevelDto = 'RED' | 'YELLOW' | 'GREEN' | 'UNCLASSIFIED';

/** Which report field a rule is evaluated against. Mirrors Prisma's MatchField enum. */
export type MatchFieldDto =
  'FINDINGS' | 'IMPRESSION' | 'REPORT_TEXT' | 'STUDY_DESCRIPTION' | 'OTHER';

/** How the keyword is compared against report text. Mirrors Prisma's MatchMode enum. */
export type MatchModeDto = 'EXACT' | 'CONTAINS' | 'REGEX';

/**
 * Issue #87: what the AI semantic judge concluded about the LOCAL CONTEXT a
 * keyword hit sits in. Mirrors Prisma's SemanticStatus enum.
 *
 * This is a statement about the report text only - it is NOT a clinical
 * judgement and NOT a monitor level. The monitor level always comes from the
 * deterministic keyword rule; the model never sets it.
 */
export type SemanticStatusDto = 'PRESENT' | 'NEGATED' | 'SUSPECTED' | 'HISTORY' | 'UNCERTAIN';

/**
 * Issue #87: the model's self-reported confidence. Mirrors Prisma's
 * SemanticConfidence enum. Only HIGH ever authorizes filtering a hit.
 */
export type SemanticConfidenceDto = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Issue #87: maximum length of MonitorRule.semanticIntent, shared so the
 * config UI's counter and the API's validation cannot drift apart. Generous
 * for a sentence or two of plain language, bounded because this text is sent
 * to a model on every judged hit and stored on every rule version.
 */
export const SEMANTIC_INTENT_MAX_LENGTH = 500;

/** One monitor_rule row as returned by the API. */
export interface MonitorRuleDto {
  id: string;
  keyword: string;
  level: MonitorLevelDto;
  matchField: MatchFieldDto;
  matchMode: MatchModeDto;
  category: string | null;
  /**
   * Issue #87: the doctor's own answer to "这个关键词想关注什么情况", in plain
   * language. Read by the AI semantic judge as the intent a hit is validated
   * against; it NEVER changes keyword matching itself.
   *
   * null/empty = not configured: such rules are skipped by the judge entirely,
   * so they behave exactly as they did before #87. Editing it is a SEMANTIC
   * edit (see rules.service.ts SEMANTIC_FIELDS) - it creates a new rule version,
   * so a historical hit keeps pointing at the intent text that was in force
   * when the AI judged it.
   */
  semanticIntent: string | null;
  isEnabled: boolean;
  version: number;
  ruleGroupId: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Query params for `GET /api/rules`. */
export interface ListMonitorRulesQuery {
  keyword?: string;
  level?: MonitorLevelDto;
  isEnabled?: boolean;
  category?: string;
  page?: number;
  pageSize?: number;
}

/** Paginated response envelope for `GET /api/rules`. */
export interface PaginatedMonitorRules {
  items: MonitorRuleDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Body for `POST /api/rules`. */
export interface CreateMonitorRuleBody {
  keyword: string;
  level: MonitorLevelDto;
  matchField: MatchFieldDto;
  matchMode?: MatchModeDto;
  category?: string | null;
  notes?: string | null;
  /** Issue #87: see MonitorRuleDto.semanticIntent. Blank/omitted = not configured. */
  semanticIntent?: string | null;
  isEnabled?: boolean;
  /**
   * Opaque actor identity. Since issue #13, the server uses the authenticated
   * user's username and IGNORES this value; it remains in the wire DTO for
   * backward compatibility (the validation pipe requires it) and as a legacy
   * fallback for callers without an access grant. Treat it as deprecated.
   */
  actorId: string;
}

/** Body for `PUT /api/rules/{id}`. All fields optional except the optimistic-lock version. */
export interface UpdateMonitorRuleBody {
  keyword?: string;
  level?: MonitorLevelDto;
  matchField?: MatchFieldDto;
  matchMode?: MatchModeDto;
  category?: string | null;
  notes?: string | null;
  /**
   * Issue #87: see MonitorRuleDto.semanticIntent. Omit to leave it unchanged;
   * send null or a blank string to clear it. Changing it is a semantic edit,
   * so the rule is re-versioned (same ruleGroupId, version + 1).
   */
  semanticIntent?: string | null;
  isEnabled?: boolean;
  /** Required optimistic-lock token: must equal the row's current `version`. */
  version: number;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId: string;
}

/** Machine-readable conflict payload nested under ApiErrorBody.error.details for 409s. */
export interface RuleConflictDetails {
  conflictingRuleId: string;
}

/** One row of a CSV import, 1-based to match spreadsheet line numbers (header = line 1). */
export interface ImportRuleRow {
  line: number;
  keyword: string;
  level: string;
  matchField: string;
  matchMode?: string;
  category?: string;
  notes?: string;
}

/** One validation error for a single import row. */
export interface ImportRowError {
  line: number;
  message: string;
}

/** Response body for `POST /api/rules/import/validate`. */
export interface ImportValidateResult {
  /** Opaque token identifying this validated batch for the confirm step. */
  importToken: string;
  totalRows: number;
  validRows: number;
  errors: ImportRowError[];
  /** Preview of rows that passed validation and would be written on confirm. */
  preview: ImportRuleRow[];
}

/** Body for `POST /api/rules/import/confirm`. */
export interface ImportConfirmBody {
  importToken: string;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId: string;
}

/** Response body for `POST /api/rules/import/confirm`. */
export interface ImportConfirmResult {
  createdCount: number;
  createdRuleIds: string[];
}
