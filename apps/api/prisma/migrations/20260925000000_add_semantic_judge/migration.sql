-- Issue #87: AI semantic judge of a keyword hit (Validate Match task).
--
-- Additive only. Nothing here changes keyword matching, the red/yellow/green
-- level system, or any existing column's meaning. Every statement is
-- idempotent (IF NOT EXISTS) so re-applying to an env that already ran it is a
-- no-op; the enums are created inside a DO block for the same reason.
--
-- Hand-written (prisma migrate dev is interactive-only); verified against the
-- schema with `prisma migrate diff --from-migrations --to-schema-datamodel`.
-- See apps/api/prisma/schema.prisma (model MonitorRule.semanticIntent, the
-- #87 block on MonitorMatch, model MonitorMatchSemantic) and docs/README.md.

-- CreateEnum
-- The model's verdict about a hit's context. NOT a monitor level and never
-- mapped to one: the model never decides red/yellow/green.
DO $$ BEGIN
    CREATE TYPE "SemanticStatus" AS ENUM ('PRESENT', 'NEGATED', 'SUSPECTED', 'HISTORY', 'UNCERTAIN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
-- Only HIGH confidence ever authorizes filtering; MEDIUM/LOW always fail open.
DO $$ BEGIN
    CREATE TYPE "SemanticConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
-- Whether the CALL succeeded, independent of what it concluded. Deliberately
-- has no SKIPPED value: a match skipped because its rule has no semantic
-- intent writes NO audit row (there was no call to audit) and is instead
-- marked resolved on monitor_match so the queue drains.
DO $$ BEGIN
    CREATE TYPE "SemanticJudgeOutcome" AS ENUM ('OK', 'ERROR');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
-- Which AI task produced a judgement row. Gains #88's report-classification
-- value only when that task lands.
DO $$ BEGIN
    CREATE TYPE "SemanticTask" AS ENUM ('VALIDATE_MATCH');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
-- The doctor's natural-language statement of what a keyword is meant to
-- catch ("这个关键词想关注什么情况"). NULL/empty = not configured: the rule is
-- skipped by the judge entirely (no model call), so a rule without an intent
-- behaves exactly as it did before #87. Read BY the judge as the intent it
-- validates against - it never feeds keyword matching.
ALTER TABLE "monitor_rule" ADD COLUMN IF NOT EXISTS "semantic_intent" TEXT;

-- AlterTable
-- AI judgement state on the match. The keyword evidence columns
-- (keyword/level/matched_field/context_snippet/matched_at) are untouched:
-- the raw hit stays the immutable, auditable record it always was.
--
-- match_start/match_end are the anchor occurrence's offsets into the original
-- field text; NULL on rows written before #87, which the judge handles by
-- re-deriving occurrences from the rule + report text.
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "match_start" INTEGER;
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "match_end" INTEGER;

-- semantic_status/semantic_confidence are the latest model VERDICT (nullable =
-- not judged yet, or no intent configured).
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_status" "SemanticStatus";
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_confidence" "SemanticConfidence";

-- semantic_filtered is the DECISION, always made by deterministic code, and is
-- one-sided by construction: nothing but the disposition matrix in
-- packages/ai-semantic can set it true, and every failure mode leaves it
-- false. `NOT NULL DEFAULT false` is what makes the pre-#87 backlog safe.
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_filtered" BOOLEAN NOT NULL DEFAULT false;

-- Queue terminal marker. The pending queue is `semantic_resolved_at IS NULL`;
-- it is set for OK, ERROR and skipped-for-no-intent alike, and never cleared.
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_resolved_at" TIMESTAMPTZ(6);

-- Claim lease + attempt counter for the judge workers (cross-process safe:
-- a stale lease is reclaimable, and attempts are bounded so a poison row
-- cannot consume model calls forever).
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_claimed_at" TIMESTAMPTZ(6);
ALTER TABLE "monitor_match" ADD COLUMN IF NOT EXISTS "semantic_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_match_monitor_record_id_semantic_filtered_idx" ON "monitor_match"("monitor_record_id", "semantic_filtered");

-- CreateIndex
-- The judge's queue scan: pending rows, oldest claim first. PARTIAL - only
-- unresolved rows are ever scanned, so the index stays proportional to the
-- backlog rather than to the whole (rapidly growing, never pruned) match
-- table. Prisma @@index cannot express a WHERE clause, so this index is
-- hand-written and NOT representable in schema.prisma: if `prisma migrate
-- dev` ever proposes dropping it as drift, re-apply it by hand (see
-- MonitorMatch's schema comment).
CREATE INDEX IF NOT EXISTS "uq_monitor_match_semantic_queue" ON "monitor_match"("semantic_claimed_at", "id") WHERE "semantic_resolved_at" IS NULL;

-- CreateTable
-- Append-only audit trail: one row per judge ATTEMPT (a retry after a timeout
-- gets its own row), explaining how the verdict denormalized onto
-- monitor_match was reached.
--
-- PRIVACY: the report text sent to the model is NOT stored - no prompt, no
-- context window, no raw model response, and no verbatim `evidence`. What is
-- stored is content hashes (evidence/input/context) plus absolute offsets into
-- the field text, which together let an auditor recompute exactly what the
-- model was shown from monitor_record's own report body (already gated behind
-- patientDetail rights). `reason` is the model's explanatory sentence, kept
-- because the issue requires the judgement to be explainable; it is
-- length-bounded and nulled for masked callers. `error` holds a machine code
-- (+ HTTP status) only, never model output, which could echo the report back.
CREATE TABLE IF NOT EXISTS "monitor_match_semantic" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "task" "SemanticTask" NOT NULL,
    "task_version" VARCHAR(50) NOT NULL,
    "outcome" "SemanticJudgeOutcome" NOT NULL,
    "semantic_status" "SemanticStatus",
    "matched" BOOLEAN,
    "confidence" "SemanticConfidence",
    "reason" VARCHAR(300),
    "intent_excludes_history" BOOLEAN,
    "evidence_hash" VARCHAR(64),
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "model" VARCHAR(100) NOT NULL,
    "model_version" VARCHAR(100),
    "input_hash" VARCHAR(64) NOT NULL,
    "context_hash" VARCHAR(64) NOT NULL,
    "context_start" INTEGER NOT NULL,
    "context_end" INTEGER NOT NULL,
    "latency_ms" INTEGER,
    "error" VARCHAR(255),
    "filtered" BOOLEAN NOT NULL DEFAULT false,
    "decision_reason" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_match_semantic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_match_semantic_match_id_created_at_idx" ON "monitor_match_semantic"("match_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_match_semantic_outcome_idx" ON "monitor_match_semantic"("outcome");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "monitor_match_semantic_decision_reason_idx" ON "monitor_match_semantic"("decision_reason");

-- AddForeignKey
-- Cascade: the audit row has no meaning without its match. NOTE this is the
-- ONE case where the "never delete a MonitorMatch" rule (#87 §forbidden) could
-- destroy audit history - matches are only ever deleted by the record-level
-- cascade (deleting a MonitorRecord), which is itself a deliberate purge, not
-- an edit path. Nothing in the AI path deletes matches.
DO $$ BEGIN
    ALTER TABLE "monitor_match_semantic" ADD CONSTRAINT "monitor_match_semantic_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "monitor_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
