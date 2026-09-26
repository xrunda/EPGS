-- Rollback for add_ai_report_classify (issue #88).
--
-- Order matters: drop the child tables BEFORE their parents, and drop every
-- column that uses a new type BEFORE dropping the type itself.
--
-- What this loses: the entire AI report-classification record - which version of
-- the hospital's attention semantics was in force, which model answered, what it
-- matched, and which excerpts backed each match. That audit trail is NOT
-- reconstructible: re-running today would replay a different model against
-- today's configuration, not the one that produced the original verdict.
-- The KEYWORD path survives untouched - monitor_match, monitor_record's
-- current_level/first_matched_at/last_matched_at and monitor_rule are unaffected,
-- and #87's own audit table is untouched, so 原始关键词命中 remains fully
-- auditable exactly as it was before #88.
--
-- What this does NOT undo - two enum values, because PostgreSQL cannot remove a
-- value from a type:
--   * SemanticTask   still contains 'CLASSIFY_REPORT'
--   * AuditAction    still contains 'ATTENTION_SEMANTIC_CREATE' / '_UPDATE'
-- Rebuilding those types would require rewriting monitor_match_semantic (and
-- audit_log), which is a far bigger and riskier operation than leaving two
-- unused values in place. Nothing can carry them once monitor_report_ai is gone,
-- and audit_log rows that already recorded an attention-semantic write must keep
-- their action regardless. The #87 rollback drops SemanticTask wholesale, so a
-- full unwind still ends clean.
--
-- Safe to run in any order relative to the code rollback, but roll the worker
-- back FIRST if you want no window in which the classifier writes to a
-- half-dropped schema (its queue is defined by monitor_record.ai_resolved_at,
-- which this file removes).

DROP TABLE IF EXISTS "monitor_report_ai_evidence";
DROP TABLE IF EXISTS "monitor_report_ai_match";
DROP TABLE IF EXISTS "monitor_report_ai";
DROP TABLE IF EXISTS "attention_semantic";

DROP INDEX IF EXISTS "uq_monitor_record_ai_queue";

ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ai_attempts";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ai_claimed_at";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ai_resolved_at";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ai_matched_at";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ai_attention_level";

-- Type drops are last and unconditional: PostgreSQL refuses DROP TYPE while a
-- column still uses it, and by here every such column is gone.
DROP TYPE IF EXISTS "ReportAiField";
DROP TYPE IF EXISTS "AttentionLevel";
