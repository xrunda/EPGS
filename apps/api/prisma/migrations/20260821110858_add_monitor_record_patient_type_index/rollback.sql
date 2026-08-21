-- Issue #14 rollback: drop the patient_type_code btree index added by the
-- forward migration. Run in reverse order (newest first) alongside the other
-- rollback scripts; see docs/go-live.md's rollback runbook.
DROP INDEX IF EXISTS "monitor_record_patient_type_code_idx";
