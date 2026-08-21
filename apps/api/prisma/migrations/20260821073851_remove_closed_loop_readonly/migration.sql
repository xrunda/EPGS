-- Migration: remove_closed_loop_readonly (issue #26)
--
-- Converges the monitoring schema to a READ-ONLY DISPLAY model:
--   * drops the closed-loop disposition model entirely: monitor_action
--     table, the ActionType/HandlingStatus/ReportStatus enums, and the
--     monitor_record.handling_status / report_status columns
--   * renames the source snapshot fields to the converged vocabulary
--     (study_accession_no -> source_record_id, study_description ->
--     exam_item, study_time -> exam_time) using data-preserving
--     RENAME COLUMN so existing rows keep their values
--   * drops the legacy snapshot fields no longer displayed
--     (patient_id_masked, inpatient_no, report_text_cache,
--     report_text_cache_expires_at)
--   * adds the display/snapshot fields from the confirmed IRIS contract
--     (bed_no, patient_type_code, patient_type_name, report_content,
--     diagnosis)
--
-- DATA GATE: this migration DROPS closed-loop disposition data. It refuses
-- to run (RAISE EXCEPTION aborts the whole transaction) while ANY
-- monitor_action row exists OR any monitor_record.handling_status differs
-- from the untouched default 'PENDING'. If the gate fires, back up the
-- database and confirm the data-loss review before re-running. The gate is
-- plain PL/pgSQL (creates no schema objects), so it does not affect
-- `prisma migrate diff` drift detection.
--
-- Rollback: see ./rollback.sql in this same directory. The rollback is
-- DESTRUCTIVE - it restores the migration-1 schema shape but CANNOT restore
-- the dropped disposition data.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "monitor_action")
     OR EXISTS (SELECT 1 FROM "monitor_record" WHERE "handling_status" <> 'PENDING') THEN
    RAISE EXCEPTION
      'remove_closed_loop_readonly aborted: monitor_action has rows, or monitor_record.handling_status <> PENDING. '
      'Closed-loop disposition data exists - back up the database and confirm the data-loss review before re-running.';
  END IF;
END $$;

-- DropIndex (indexes on the disposition-status columns being dropped)
DROP INDEX "monitor_record_report_status_idx";
DROP INDEX "monitor_record_handling_status_idx";

-- RenameColumn (data-preserving - every existing row keeps its value)
ALTER TABLE "monitor_record" RENAME COLUMN "study_accession_no" TO "source_record_id";
ALTER TABLE "monitor_record" RENAME COLUMN "study_description" TO "exam_item";
ALTER TABLE "monitor_record" RENAME COLUMN "study_time" TO "exam_time";

-- RenameIndex (the three indexes follow the renamed columns; retarget their
-- names to the canonical derived names Prisma generates from the datamodel)
ALTER INDEX "monitor_record_study_time_idx" RENAME TO "monitor_record_exam_time_idx";
ALTER INDEX "monitor_record_study_accession_no_report_id_idx" RENAME TO "monitor_record_source_record_id_report_id_idx";
ALTER INDEX "monitor_record_study_accession_no_report_id_report_version_key" RENAME TO "monitor_record_source_record_id_report_id_report_version_key";

-- DropColumn (legacy/closed-loop columns)
ALTER TABLE "monitor_record" DROP COLUMN "patient_id_masked";
ALTER TABLE "monitor_record" DROP COLUMN "inpatient_no";
ALTER TABLE "monitor_record" DROP COLUMN "report_status";
ALTER TABLE "monitor_record" DROP COLUMN "handling_status";
ALTER TABLE "monitor_record" DROP COLUMN "report_text_cache";
ALTER TABLE "monitor_record" DROP COLUMN "report_text_cache_expires_at";

-- AddColumn (new read-only display/snapshot fields; all nullable, no default)
ALTER TABLE "monitor_record" ADD COLUMN "bed_no" VARCHAR(50);
ALTER TABLE "monitor_record" ADD COLUMN "patient_type_code" VARCHAR(20);
ALTER TABLE "monitor_record" ADD COLUMN "patient_type_name" VARCHAR(50);
ALTER TABLE "monitor_record" ADD COLUMN "report_content" TEXT;
ALTER TABLE "monitor_record" ADD COLUMN "diagnosis" TEXT;

-- DropTable (monitor_action; its FK + 3 indexes drop implicitly with it)
DROP TABLE "monitor_action";

-- DropEnum (strictly after every column/table that referenced them is gone)
DROP TYPE "ActionType";
DROP TYPE "HandlingStatus";
DROP TYPE "ReportStatus";
