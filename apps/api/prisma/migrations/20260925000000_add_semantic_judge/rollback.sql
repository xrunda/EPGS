-- Rollback for add_semantic_judge (issue #87).
--
-- Order matters: drop the audit table BEFORE the types it depends on.
--
-- What this loses: every AI judgement record (verdict provenance: which model,
-- which prompt/task version, which input hash, which offsets, what the reason
-- was). That audit trail is NOT reconstructible - re-judging replays today's
-- model, not the one that produced the original verdict, and the rate/state at
-- the time is gone. The KEYWORD evidence survives untouched: monitor_match,
-- monitor_record and their level columns are unaffected by this rollback, and
-- 原始关键字命中 remains fully auditable exactly as it was before #87.
--
-- What this does NOT undo: nothing else. With the columns gone the worker's
-- judge loop finds no queue and stops calling the model, so behaviour reverts
-- to pre-#87 (keyword hits are never filtered). Safe to run in any order
-- relative to the code rollback, but roll the worker back FIRST if you want no
-- window in which the judge writes to a half-dropped schema.

DROP TABLE IF EXISTS "monitor_match_semantic";

DROP INDEX IF EXISTS "uq_monitor_match_semantic_queue";
DROP INDEX IF EXISTS "monitor_match_monitor_record_id_semantic_filtered_idx";

ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_attempts";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_claimed_at";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_resolved_at";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_filtered";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_confidence";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "semantic_status";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "match_end";
ALTER TABLE "monitor_match" DROP COLUMN IF EXISTS "match_start";

ALTER TABLE "monitor_rule" DROP COLUMN IF EXISTS "semantic_intent";

-- Type drops are last and unconditional: PostgreSQL refuses DROP TYPE while a
-- column still uses it, and by here every such column is gone. No data depends
-- on them once monitor_match_semantic is dropped.
DROP TYPE IF EXISTS "SemanticTask";
DROP TYPE IF EXISTS "SemanticJudgeOutcome";
DROP TYPE IF EXISTS "SemanticConfidence";
DROP TYPE IF EXISTS "SemanticStatus";
