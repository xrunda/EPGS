-- Rollback for migration: 20260821040339_init_monitoring_schema (issue #3)
--
-- This is NOT auto-applied by Prisma (Prisma Migrate has no built-in "down"
-- concept for its migration history table). It is provided so this
-- migration can be manually rolled back on a dev/staging database, and to
-- satisfy the "migrations must support upgrade AND rollback" acceptance
-- criterion for issue #3.
--
-- Usage (manual):
--   psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821040339_init_monitoring_schema/rollback.sql
--   Then remove the corresponding row from the "_prisma_migrations" table:
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260821040339_init_monitoring_schema';
--
-- WARNING: this is destructive. It drops every table created by the
-- forward migration, including any data written since. Only run it where
-- data loss is acceptable (empty DB, dev/staging, or a confirmed backup
-- exists).

-- Drop foreign keys first (defensive; DROP TABLE CASCADE below would also
-- remove them, but being explicit documents intent and matches the forward
-- migration's own explicit "AddForeignKey" steps).
ALTER TABLE IF EXISTS "monitor_action" DROP CONSTRAINT IF EXISTS "monitor_action_monitor_record_id_fkey";
ALTER TABLE IF EXISTS "monitor_match" DROP CONSTRAINT IF EXISTS "monitor_match_rule_id_fkey";
ALTER TABLE IF EXISTS "monitor_match" DROP CONSTRAINT IF EXISTS "monitor_match_monitor_record_id_fkey";

-- Drop tables in FK-dependency-safe order (children before parents).
DROP TABLE IF EXISTS "monitor_action";
DROP TABLE IF EXISTS "monitor_match";
DROP TABLE IF EXISTS "sync_job_log";
DROP TABLE IF EXISTS "monitor_record";
DROP TABLE IF EXISTS "monitor_rule";

-- Drop enums (after all tables referencing them are gone).
DROP TYPE IF EXISTS "SyncJobStatus";
DROP TYPE IF EXISTS "ActionType";
DROP TYPE IF EXISTS "ReportStatus";
DROP TYPE IF EXISTS "MatchMode";
DROP TYPE IF EXISTS "MatchField";
DROP TYPE IF EXISTS "HandlingStatus";
DROP TYPE IF EXISTS "MonitorLevel";
