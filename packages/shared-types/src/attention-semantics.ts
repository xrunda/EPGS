/**
 * Stable DTOs for the attention_semantic CRUD API (issue #88).
 *
 * WHAT AN ATTENTION SEMANTIC IS: one meaning a hospital wants to be told about,
 * written in the doctor's own words, plus the colour that meaning carries. It is
 * management configuration, not a diagnosis, and not a statement about severity
 * - see docs/data-dictionary.md for the wording that must appear wherever these
 * are shown.
 *
 * HOW IT DIFFERS FROM A MONITOR RULE: a rule matches TEXT (a keyword in a
 * field). A semantic describes MEANING, and is judged by the AI classifier
 * against a whole report. A report can therefore be flagged by a semantic whose
 * wording appears nowhere in it - which is the entire point of #88, and also why
 * the keyword path is unaffected by anything configured here.
 *
 * These mirror apps/api's Prisma `AttentionSemantic` model at the wire level
 * (see apps/api/prisma/schema.prisma and docs/data-dictionary.md for the
 * authoritative field-level documentation).
 */

/** Colour a hospital assigns to one attention semantic. Mirrors Prisma's AttentionLevel enum. */
export type AttentionLevelDto = 'RED' | 'YELLOW' | 'GREEN';

/** Runtime list of every AttentionLevelDto, for UI pickers and validation. */
export const ATTENTION_LEVELS_DTO: readonly AttentionLevelDto[] = ['RED', 'YELLOW', 'GREEN'];

/**
 * Maximum length of an attention semantic's `name`, shared so the config UI's
 * counter and the API's validation cannot drift apart. Same value as
 * ATTENTION_SEMANTIC_NAME_MAX_LENGTH in @epgs/ai-semantic, which enforces it on
 * the classifier's own snapshot.
 */
export const ATTENTION_SEMANTIC_NAME_MAX_LENGTH = 100;

/**
 * Maximum length of an attention semantic's `description`, shared for the same
 * reason. Kept short on purpose (issue #88 §6): one entry should express ONE
 * intent, so a description that needs more room is a sign it should be split.
 */
export const ATTENTION_SEMANTIC_DESCRIPTION_MAX_LENGTH = 300;

/** One attention_semantic row as returned by the API. */
export interface AttentionSemanticDto {
  id: string;
  /**
   * Identifies the LOGICAL semantic this row is a version of. A row's group is
   * its own id on creation; editing name/description/level creates a NEW row
   * with the same group and `version + 1`, and disables the old one. So the
   * current configuration for one semantic is the highest-version row in its
   * group, and a historical AI match keeps pointing at the exact wording that
   * was in force when the report was judged.
   */
  semanticGroupId: string;
  name: string;
  /** The doctor's plain-language statement of the meaning to watch for. */
  description: string;
  attentionLevel: AttentionLevelDto;
  isEnabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Query params for `GET /api/attention-semantics`. */
export interface ListAttentionSemanticsQuery {
  /** Substring filter on name (case-insensitive). */
  name?: string;
  attentionLevel?: AttentionLevelDto;
  isEnabled?: boolean;
  page?: number;
  pageSize?: number;
}

/** Paginated response envelope for `GET /api/attention-semantics`. */
export interface PaginatedAttentionSemantics {
  items: AttentionSemanticDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Body for `POST /api/attention-semantics`. */
export interface CreateAttentionSemanticBody {
  name: string;
  description: string;
  attentionLevel: AttentionLevelDto;
  isEnabled?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId: string;
}

/**
 * Body for `PUT /api/attention-semantics/{id}`.
 *
 * All fields optional except the optimistic-lock `version`. Changing any of
 * name/description/attentionLevel creates a NEW versioned row; changing only
 * isEnabled edits in place.
 */
export interface UpdateAttentionSemanticBody {
  name?: string;
  description?: string;
  attentionLevel?: AttentionLevelDto;
  isEnabled?: boolean;
  /** Required optimistic-lock token: must equal the row's current `version`. */
  version: number;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId: string;
}

/** Machine-readable conflict payload nested under ApiErrorBody.error.details for 409s. */
export interface AttentionSemanticConflictDetails {
  conflictingSemanticId: string;
}

/** Body for `POST /api/attention-semantics/import-defaults`. */
export interface ImportAttentionSemanticsBody {
  /**
   * When true, a default whose name already exists at a different colour is
   * re-versioned to the template's colour. Defaults to false: the hospital's
   * own colour choice is never overwritten by a button press.
   */
  overwriteExisting?: boolean;
  /** Deprecated since issue #13 - the authenticated username is authoritative. */
  actorId: string;
}

/** Response body for `POST /api/attention-semantics/import-defaults`. */
export interface ImportAttentionSemanticsResult {
  /** How many semantics were newly created (version 1 rows). */
  createdCount: number;
  /** How many already existed and were left exactly as they were. */
  skippedCount: number;
  /** How many already existed and were re-versioned (only when overwriteExisting). */
  updatedCount: number;
  /** Ids of the rows that are now the current version of each imported semantic. */
  semanticIds: string[];
}
