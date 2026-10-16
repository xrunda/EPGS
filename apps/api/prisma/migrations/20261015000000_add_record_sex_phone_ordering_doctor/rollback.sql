-- Rollback for add_record_sex_phone_ordering_doctor (issue #137).
--
-- Three plain column drops, in reverse order. Nothing depends on them - no
-- index, no constraint, no foreign key - so no ordering constraint beyond
-- dropping all three together.
--
-- What this loses: the sex, phone and ordering-doctor snapshot for every
-- record. Unlike #88's audit trail this IS reconstructible - all three are
-- still in the source system, and a re-sync with the columns back in place
-- restores them. The loss is therefore operational (records show "—" until the
-- next sync window covers them), not archival.
--
-- One caveat if you roll the schema back but NOT the code: the API's
-- LIST_SELECT / DETAIL_INCLUDE name these columns explicitly, so the workbench
-- and the detail drawer would fail with a missing-column error rather than
-- degrading. Roll the api and worker processes back together with this file.
--
-- Safe to run in any order relative to the worker rollback: the worker's write
-- path names the columns too, so the same caveat applies to api, worker and this
-- file as one unit.

ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "ordering_doctor";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "patient_phone";
ALTER TABLE "monitor_record" DROP COLUMN IF EXISTS "patient_sex";
