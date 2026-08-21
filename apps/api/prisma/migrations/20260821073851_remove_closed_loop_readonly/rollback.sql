-- Rollback for: remove_closed_loop_readonly (issue #26)
--
-- Reverses the forward migration back to the init_monitoring_schema
-- (migration-1) state: recreates monitor_action + the
-- ActionType/HandlingStatus/ReportStatus enums, restores the dropped
-- monitor_record columns (with their migration-1 DEFAULTs), renames the
-- renamed columns/indexes back, and drops the 5 new display columns.
--
-- WARNING: DESTRUCTIVE down-migration. monitor_action rows and the values
-- in monitor_record.handling_status / report_status / patient_id_masked /
-- inpatient_no / report_text_cache / report_text_cache_expires_at were
-- DROPPED by the forward migration and CANNOT be restored - the re-added
-- columns come back empty (NULL / enum DEFAULT). Only run where that loss
-- is acceptable.
--
-- Usage (mirrors migration-1's rollback.sql):
--   psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821073851_remove_closed_loop_readonly/rollback.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260821073851_remove_closed_loop_readonly';
-- To fully reset to EMPTY (pre-migration-1), run migration-1's rollback.sql
-- afterwards and clear BOTH history rows.

-- Recreate enums (before any column/table that references them).
CREATE TYPE "ActionType" AS ENUM ('REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'MARKED_FALSE_POSITIVE', 'REOPENED');
CREATE TYPE "HandlingStatus" AS ENUM ('PENDING', 'REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');
CREATE TYPE "ReportStatus" AS ENUM ('PRELIMINARY', 'FINAL', 'AMENDED', 'UNKNOWN');

-- Recreate monitor_action (mirror migration-1 exactly).
CREATE TABLE "monitor_action" (
    "id" UUID NOT NULL,
    "monitor_record_id" UUID NOT NULL,
    "action_type" "ActionType" NOT NULL,
    "actor_id" VARCHAR(100) NOT NULL,
    "recipient_id" VARCHAR(100),
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_action_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "monitor_action_monitor_record_id_occurred_at_idx" ON "monitor_action"("monitor_record_id", "occurred_at");
CREATE INDEX "monitor_action_action_type_idx" ON "monitor_action"("action_type");
CREATE INDEX "monitor_action_occurred_at_idx" ON "monitor_action"("occurred_at");
ALTER TABLE "monitor_action" ADD CONSTRAINT "monitor_action_monitor_record_id_fkey"
  FOREIGN KEY ("monitor_record_id") REFERENCES "monitor_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rename columns back (preserves whatever data the forward migration kept).
ALTER TABLE "monitor_record" RENAME COLUMN "source_record_id" TO "study_accession_no";
ALTER TABLE "monitor_record" RENAME COLUMN "exam_item" TO "study_description";
ALTER TABLE "monitor_record" RENAME COLUMN "exam_time" TO "study_time";

-- Rename indexes back to migration-1 names.
ALTER INDEX "monitor_record_source_record_id_report_id_report_version_key" RENAME TO "monitor_record_study_accession_no_report_id_report_version_key";
ALTER INDEX "monitor_record_source_record_id_report_id_idx" RENAME TO "monitor_record_study_accession_no_report_id_idx";
ALTER INDEX "monitor_record_exam_time_idx" RENAME TO "monitor_record_study_time_idx";

-- Re-add the dropped columns. Data is NOT restorable - this restores the
-- migration-1 shape only.
ALTER TABLE "monitor_record" ADD COLUMN "patient_id_masked" VARCHAR(50);
ALTER TABLE "monitor_record" ADD COLUMN "inpatient_no" VARCHAR(64);
ALTER TABLE "monitor_record" ADD COLUMN "report_status" "ReportStatus" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "monitor_record" ADD COLUMN "handling_status" "HandlingStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "monitor_record" ADD COLUMN "report_text_cache" TEXT;
ALTER TABLE "monitor_record" ADD COLUMN "report_text_cache_expires_at" TIMESTAMPTZ(6);

-- Recreate the two indexes dropped in the forward migration.
CREATE INDEX "monitor_record_report_status_idx" ON "monitor_record"("report_status");
CREATE INDEX "monitor_record_handling_status_idx" ON "monitor_record"("handling_status");

-- Drop the 5 new display columns.
ALTER TABLE "monitor_record" DROP COLUMN "bed_no";
ALTER TABLE "monitor_record" DROP COLUMN "patient_type_code";
ALTER TABLE "monitor_record" DROP COLUMN "patient_type_name";
ALTER TABLE "monitor_record" DROP COLUMN "report_content";
ALTER TABLE "monitor_record" DROP COLUMN "diagnosis";
