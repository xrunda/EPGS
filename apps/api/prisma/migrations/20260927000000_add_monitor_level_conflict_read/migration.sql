-- Issue #103: admin read state for attention-level conflicts.
--
-- A level conflict is one place in the report where the keyword path and the
-- report-level (AI) path BOTH found something but asked for DIFFERENT attention
-- levels - a configuration problem a human has to settle, which the product
-- previously showed as two ordinary rows in one list.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not store the conflicts. They are
-- recomputed on every read from monitor_match's offsets and the monitor_report_ai*
-- rows, by the same `findLevelConflicts` the doctor's drawer uses
-- (apps/api/src/monitor/level-conflict.ts). A stored copy would be a second
-- source of truth that drifts the instant a rule is edited, and there is nothing
-- to buy with it: the number of distinct conflicts is a function of the
-- CONFIGURATION (rules x semantics x columns), not of record volume.
--
-- So the only thing persisted is what genuinely cannot be recomputed: whether a
-- human has already looked at a given conflict.
--
-- NOT A CLOSED LOOP (issue #26). The key is a CONFIGURATION defect - rule group +
-- semantic group + report column + the two levels - and never a patient, a
-- report, or anyone's handling of one. The product wording follows from that:
-- 已读 / 未读, not 已处理 / 已知晓.
--
-- Additive only. Nothing here touches keyword matching, the levels, #87's judge,
-- #88's classification or the notification path, and the new table has no FK to
-- anything. Every statement is idempotent (IF NOT EXISTS / DO ... EXCEPTION) so
-- re-applying to an env that already ran it is a no-op.
--
-- Hand-written (prisma migrate dev is interactive-only); verified against the
-- schema with `prisma migrate diff --from-schema-datasource --to-schema-datamodel`.
-- See apps/api/prisma/schema.prisma (model MonitorLevelConflictRead) and
-- docs/monitor-level-conflict-api.md.

-- AlterEnum
-- NOTE: PostgreSQL cannot remove an enum value, so these two are NOT undone by
-- rollback.sql - see the note there. Leaving them is harmless: no row can carry
-- them once the table below is gone.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MONITOR_LEVEL_CONFLICT_READ';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MONITOR_LEVEL_CONFLICT_UNREAD';

-- CreateTable
-- One row per conflict a human has touched. A conflict with NO row here is
-- unread - the default state - so the table holds only the decisions, and its
-- size is bounded by the configuration rather than by patient volume.
--
-- conflict_key is `ruleGroupId:semanticGroupId:field:keywordLevel:aiLevel`, and
-- every part of it has a column here so a row can be read without parsing
-- anything. It is built from GROUP ids, not from the versioned rule/semantic
-- rows: those are immutable and versioned, so a re-worded rule or a re-coloured
-- semantic creates new rows and would otherwise resurrect a todo an admin has
-- already read. `field` is in the key because one rule can hit both
-- report_content and diagnosis - two different places in the report, so two
-- different problems to settle. The two LEVELS are in it for the same reason:
-- re-colouring either side makes it a different disagreement, which comes back
-- unread.
--
-- read_at is the terminal timestamp (the convention MonitorRecord.ai_resolved_at
-- already uses): NULL = unread, non-NULL = the instant it was marked read. The
-- row is kept when an admin marks it back to unread, and read_by is overwritten
-- with that actor - the useful fact later is "the last person to look at this
-- decided it was not worth acting on", which deleting the row would throw away.
--
-- No FOREIGN KEY by design: monitor_rule and attention_semantic are soft-disabled,
-- never deleted, so a plain uuid keeps this table free of any cascade behaviour.
CREATE TABLE IF NOT EXISTS "monitor_level_conflict_read" (
    "id" UUID NOT NULL,
    "conflict_key" VARCHAR(200) NOT NULL,
    "rule_group_id" UUID NOT NULL,
    "semantic_group_id" UUID NOT NULL,
    "field" "MatchField" NOT NULL,
    "keyword_level" "MonitorLevel" NOT NULL,
    "ai_level" "AttentionLevel" NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "read_by" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "monitor_level_conflict_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The natural key: one row per conflict, whatever else happens. This is also
-- what makes marking read idempotent under concurrency - two admins clicking at
-- once produce one row, and the second upsert just rewrites the timestamp.
CREATE UNIQUE INDEX IF NOT EXISTS "monitor_level_conflict_read_conflict_key_key" ON "monitor_level_conflict_read"("conflict_key");

-- CreateIndex
-- The list's default order is 未读优先, so the unread set is scanned first.
CREATE INDEX IF NOT EXISTS "monitor_level_conflict_read_read_at_idx" ON "monitor_level_conflict_read"("read_at");
