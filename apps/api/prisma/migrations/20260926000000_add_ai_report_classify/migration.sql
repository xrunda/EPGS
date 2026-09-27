-- Issue #88: AI report classification (Classify Report task).
--
-- Adds a SECOND, independent AI path: the model reads a whole report and matches
-- it against the hospital's configured red/yellow/green "attention semantics".
-- It does not depend on a keyword having matched, which is the entire point of
-- the feature.
--
-- Additive only. Nothing here changes keyword matching, the red/yellow/green
-- level system, #87's judge, or the notification path. Every statement is
-- idempotent (IF NOT EXISTS / DO ... EXCEPTION) so re-applying to an env that
-- already ran it is a no-op.
--
-- ONE-SIDED BY CONSTRUCTION: the columns added to monitor_record are AI RESULTS
-- plus queue bookkeeping. There is no column here that the AI path can use to
-- REMOVE a keyword hit, lower a level, or mark a record as "not worth
-- attention". Every failure mode of the task leaves all of them untouched.
--
-- Hand-written (prisma migrate dev is interactive-only); verified against the
-- schema with `prisma migrate diff --from-schema-datasource --to-schema-datamodel`.
-- See apps/api/prisma/schema.prisma (model AttentionSemantic, MonitorReportAi,
-- MonitorReportAiMatch, MonitorReportAiEvidence, the #88 block on
-- MonitorRecord) and docs/ai-semantic-monitor-design.md.

-- CreateEnum
-- The colour a hospital assigns to one attention semantic. Deliberately has no
-- UNCLASSIFIED member (unlike MonitorLevel): an entry always carries an explicit
-- colour, and "unclassified" is a property of a REPORT (nothing matched it),
-- not of a configured semantic. On monitor_record.ai_attention_level the
-- absence of a value is expressed as NULL.
DO $$ BEGIN
    CREATE TYPE "AttentionLevel" AS ENUM ('RED', 'YELLOW', 'GREEN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
-- The report fields the Classify Report task sends, and therefore the only
-- fields an AI evidence offset can point into. Deliberately NOT a reuse of
-- MatchField: that is the KEYWORD engine's vocabulary, where STUDY_DESCRIPTION
-- means "检查描述" and has no dedicated text source in monitor_record - so
-- "检查项目" would be unrepresentable. Each value here maps to a real column:
--   EXAM_ITEM  -> monitor_record.exam_item
--   FINDINGS   -> monitor_record.report_content  (报告正文 / 检查所见)
--   IMPRESSION -> monitor_record.diagnosis       (诊断意见)
DO $$ BEGIN
    CREATE TYPE "ReportAiField" AS ENUM ('EXAM_ITEM', 'FINDINGS', 'IMPRESSION');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
-- #88's task. NOTE: PostgreSQL cannot remove an enum value, so this one is NOT
-- undone by rollback.sql - see the note there. Leaving it in place is harmless:
-- no row can carry it once monitor_report_ai is gone.
ALTER TYPE "SemanticTask" ADD VALUE IF NOT EXISTS 'CLASSIFY_REPORT';

-- AlterEnum
-- Attention-semantic configuration writes, mirroring RULE_CREATE/RULE_UPDATE for
-- keyword rules. Same caveat as above: not removable by rollback.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ATTENTION_SEMANTIC_CREATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ATTENTION_SEMANTIC_UPDATE';

-- AlterTable
-- AI state on the record. Denormalized cache of the newest SUCCESSFUL
-- classification; the audit trail is monitor_report_ai (one row per attempt).
--
-- ai_attention_level is the level DETERMINISTIC CODE computed (max configured
-- level across verified matches) - never the model's own claim. NULL means
-- "never classified / every attempt failed / classifier disabled"; a successful
-- classification that matched nothing also leaves it NULL, and the two are told
-- apart in monitor_report_ai (outcome OK with match_count 0 vs. no OK row).
--
-- ai_matched_at is kept separate from first/last_matched_at on purpose: those
-- two are the KEYWORD path's facts and must not be overwritten by AI findings.
--
-- Queue shape mirrors #87's: the pending set is `ai_resolved_at IS NULL`, so a
-- terminal marker (not a status column) is what drains it. ai_claimed_at +
-- ai_attempts make the claim cross-process safe and bound a poison record's
-- model spend.
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ai_attention_level" "AttentionLevel";
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ai_matched_at" TIMESTAMPTZ(6);
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ai_resolved_at" TIMESTAMPTZ(6);
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ai_claimed_at" TIMESTAMPTZ(6);
ALTER TABLE "monitor_record" ADD COLUMN IF NOT EXISTS "ai_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
-- The classifier's queue scan: pending records, oldest claim first. PARTIAL -
-- only unresolved rows are scanned, so the index stays proportional to the
-- backlog rather than to the whole (rapidly growing, never pruned) record
-- table. Prisma @@index cannot express a WHERE clause, so this index is
-- hand-written and NOT representable in schema.prisma: if `prisma migrate dev`
-- ever proposes dropping it as drift, re-apply it by hand (same caveat as
-- uq_monitor_match_semantic_queue and uq_push_log_scheduled_dedup).
CREATE INDEX IF NOT EXISTS "uq_monitor_record_ai_queue" ON "monitor_record"("ai_claimed_at", "id") WHERE "ai_resolved_at" IS NULL;

-- CreateTable
-- Hospital-configured attention semantics (关注语义). Versioned exactly like
-- monitor_rule: an edit that changes what the semantic MEANS (name /
-- description / attention_level, including moving it between colours) inserts a
-- NEW row with version+1 and the same semantic_group_id, and disables the old
-- one. Rows are never deleted, because monitor_report_ai_match.semantic_id
-- references the exact version row a judgement was made against - that
-- reference is what answers "依据的是医院哪一版关注语义".
CREATE TABLE IF NOT EXISTS "attention_semantic" (
    "id" UUID NOT NULL,
    "semantic_group_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "attention_level" "AttentionLevel" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100) NOT NULL,

    CONSTRAINT "attention_semantic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "attention_semantic_semantic_group_id_idx" ON "attention_semantic"("semantic_group_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "attention_semantic_attention_level_is_enabled_idx" ON "attention_semantic"("attention_level", "is_enabled");

-- CreateTable
-- Append-only audit trail: one row per classification ATTEMPT (a retry after a
-- timeout gets its own row). Answers issue #88 §13 - "why was this report
-- judged red, and which version of the hospital's attention semantics was used"
-- - via config_hash + report_hash + input_hash and the per-match rows below.
--
-- PRIVACY: the report text sent to the model is NOT stored - no prompt, no raw
-- model response, and no verbatim evidence. What is stored is content hashes
-- plus (on the evidence rows) offsets into monitor_record's report body, which
-- is already stored and already gated behind patientDetail rights. `error`
-- holds a machine code only, never model output, which could echo the report
-- back.
--
-- model_attention_level is what the MODEL claimed; attention_level is what CODE
-- computed. If they disagree the attempt is rejected as INCOHERENT_LEVEL and no
-- match row is written, so the model's claim can never move a level - it exists
-- so model drift is measurable.
CREATE TABLE IF NOT EXISTS "monitor_report_ai" (
    "id" UUID NOT NULL,
    "monitor_record_id" UUID NOT NULL,
    "report_version" INTEGER NOT NULL,
    "task" "SemanticTask" NOT NULL,
    "task_version" VARCHAR(50) NOT NULL,
    "outcome" "SemanticJudgeOutcome" NOT NULL,
    "attention_level" "AttentionLevel",
    "model_attention_level" "AttentionLevel",
    "semantic_count" INTEGER NOT NULL,
    "match_count" INTEGER NOT NULL,
    "error" VARCHAR(64),
    "model" VARCHAR(100) NOT NULL,
    "model_version" VARCHAR(100),
    "input_hash" VARCHAR(64) NOT NULL,
    "report_hash" VARCHAR(64) NOT NULL,
    "config_hash" VARCHAR(64) NOT NULL,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_report_ai_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_monitor_record_id_created_at_idx" ON "monitor_report_ai"("monitor_record_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_outcome_idx" ON "monitor_report_ai"("outcome");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_attention_level_idx" ON "monitor_report_ai"("attention_level");

-- CreateTable
-- One attention semantic a classification verified as matching. ALL matches are
-- saved (issue #88 §8) - the final level is the maximum of attention_level
-- across these rows, computed by code, and a RED match never causes a YELLOW or
-- GREEN one to be dropped. semantic_version/semantic_name/attention_level are
-- snapshots, so the row stays a faithful record even after the entry is renamed
-- or moved between colours.
CREATE TABLE IF NOT EXISTS "monitor_report_ai_match" (
    "id" UUID NOT NULL,
    "report_ai_id" UUID NOT NULL,
    "semantic_id" UUID NOT NULL,
    "semantic_version" INTEGER NOT NULL,
    "semantic_name" VARCHAR(100) NOT NULL,
    "attention_level" "AttentionLevel" NOT NULL,
    "confidence" "SemanticConfidence" NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "monitor_report_ai_match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_match_report_ai_id_idx" ON "monitor_report_ai_match"("report_ai_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_match_semantic_id_idx" ON "monitor_report_ai_match"("semantic_id");

-- CreateIndex
-- The model returning the same semantic_id twice is a contract violation the
-- parser rejects before any write; this constraint is the backstop that makes
-- "one row per (attempt, semantic)" true even if a future code path forgets.
CREATE UNIQUE INDEX IF NOT EXISTS "monitor_report_ai_match_report_ai_id_semantic_id_key" ON "monitor_report_ai_match"("report_ai_id", "semantic_id");

-- CreateTable
-- Verified evidence backing one match (issue #88 §9). The excerpt itself is NOT
-- stored - only its hash and where it sits in the report body, exactly as #87
-- does. An auditor entitled to read monitor_record recomputes it from these
-- offsets. A match with no surviving evidence row is not a valid match at all:
-- the strict contract rejects the WHOLE attempt if any evidence cannot be
-- located, so a partially-grounded result can never be silently downgraded.
CREATE TABLE IF NOT EXISTS "monitor_report_ai_evidence" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "field" "ReportAiField" NOT NULL,
    "evidence_hash" VARCHAR(64) NOT NULL,
    "evidence_start" INTEGER NOT NULL,
    "evidence_end" INTEGER NOT NULL,

    CONSTRAINT "monitor_report_ai_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_report_ai_evidence_match_id_idx" ON "monitor_report_ai_evidence"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "monitor_report_ai_evidence_match_id_ordinal_key" ON "monitor_report_ai_evidence"("match_id", "ordinal");

-- AddForeignKey
-- Cascade: an AI attempt has no meaning without its record.
DO $$ BEGIN
    ALTER TABLE "monitor_report_ai" ADD CONSTRAINT "monitor_report_ai_monitor_record_id_fkey" FOREIGN KEY ("monitor_record_id") REFERENCES "monitor_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "monitor_report_ai_match" ADD CONSTRAINT "monitor_report_ai_match_report_ai_id_fkey" FOREIGN KEY ("report_ai_id") REFERENCES "monitor_report_ai"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
-- Restrict, NOT Cascade (mirrors monitor_match.rule): attention semantics are
-- soft-disabled, never deleted, so this FK can never fire in practice - and if
-- someone ever tries to hard-delete one, refusing is the correct answer,
-- because it would orphan the audit trail that points at this exact version.
DO $$ BEGIN
    ALTER TABLE "monitor_report_ai_match" ADD CONSTRAINT "monitor_report_ai_match_semantic_id_fkey" FOREIGN KEY ("semantic_id") REFERENCES "attention_semantic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "monitor_report_ai_evidence" ADD CONSTRAINT "monitor_report_ai_evidence_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "monitor_report_ai_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
