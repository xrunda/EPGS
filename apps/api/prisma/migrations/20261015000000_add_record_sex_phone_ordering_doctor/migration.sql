-- Issue #137: three patient/study snapshot columns the hospital's DHC/Ensemble
-- gateway added to the W00000206 query - 性别 / 手机号 / 开单医生.
--
-- Additive only. Nothing here touches keyword matching, the red/yellow/green
-- levels, #87's judge, #88's classification, the alert-link surface or the
-- notification path: these are DISPLAY snapshots, sitting next to patient_name /
-- department / bed_no / exam_item, and no code path branches on them. Every
-- statement is idempotent (IF NOT EXISTS) so re-applying to an env that already
-- ran it is a no-op.
--
-- WHY THEY ARE NULLABLE, AND WHY THAT IS NOT A GAP. The gateway may omit a
-- column (older deployment, a different KeyName), a value may be genuinely
-- empty (门诊 patients have no bed and often no phone on file), and every row
-- already in this table was synced before the columns existed. All four cases
-- mean the same thing to a reader - "no value" - which the workbench already
-- renders as "—". A NOT NULL default would invent a value nobody measured.
-- Existing rows stay NULL until their report is re-synced; the sync job's
-- already-up-to-date branch refreshes snapshot fields, so a re-sync of an
-- unchanged report is what backfills them.
--
-- SENSITIVITY (docs/data-dictionary.md):
--   patient_sex      MEDIUM - does not identify a patient on its own, not masked.
--   ordering_doctor  MEDIUM - a member of STAFF, not a patient; not masked.
--   patient_phone    HIGH   - the most directly identifying value this schema
--                             stores. Never logged, never written to audit
--                             meta, never pushed, never sent to a model, and
--                             never served in a LIST response. The detail read
--                             masks it unless the caller holds the
--                             `patientDetail` grant (#13), via
--                             apps/api/src/access/data-scope.ts.
--
-- NO INDEX, deliberately. These columns are display-only: nothing filters,
-- sorts or joins on them, so an index would be write cost with no reader.
--
-- Hand-written (prisma migrate dev is interactive-only); verified against the
-- schema with `prisma migrate diff --from-schema-datasource --to-schema-datamodel`.
-- See apps/api/prisma/schema.prisma (model MonitorRecord, the #137 block),
-- packages/shared-types/src/pacs-ris.ts (PacsReportDto) and
-- docs/api/pacs-ris-data-api.md.

-- AlterTable
-- 性别. Verbatim text, not an enum: the source has no code dictionary for this
-- column, and docs/data-dictionary.md forbids guessing one. VARCHAR(10) is
-- generous for what is a one-character value in practice.
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "patient_sex" VARCHAR(10);

-- AlterTable
-- 手机号. Low-sensitivity STORAGE is a deliberate, product-owner-approved
-- decision: the number is useful for contacting a patient who needs attention,
-- so it is kept rather than dropped at the adapter. The protection is on every
-- READ path instead (see the sensitivity note above), which is why this column
-- being present is not by itself an exposure.
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "patient_phone" VARCHAR(30);

-- AlterTable
-- 开单医生. A staff name, snapshotted like the rest of the study fields so the
-- record keeps showing who requested it even if the source later changes.
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ordering_doctor" VARCHAR(100);
