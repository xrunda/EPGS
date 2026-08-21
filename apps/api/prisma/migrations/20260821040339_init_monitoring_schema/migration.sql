-- Migration: init_monitoring_schema (issue #3)
--
-- Creates the EPGS monitoring business schema: monitor_rule, monitor_record,
-- monitor_match, monitor_action, sync_job_log, and their enums/indexes/FKs.
-- This is the FIRST migration for this schema (no prior tables), so it is
-- purely additive and safe to run on an empty database.
--
-- Rollback: see ./rollback.sql in this same directory, which drops
-- everything created here in FK-safe order. Rollback is destructive (data
-- loss) by nature for a DROP-based down-migration; only run it against an
-- environment where that is acceptable (dev/staging, or before any data has
-- been written in prod).
--
-- CreateEnum
CREATE TYPE "MonitorLevel" AS ENUM ('RED', 'YELLOW', 'GREEN', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "HandlingStatus" AS ENUM ('PENDING', 'REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "MatchField" AS ENUM ('FINDINGS', 'IMPRESSION', 'REPORT_TEXT', 'STUDY_DESCRIPTION', 'OTHER');

-- CreateEnum
CREATE TYPE "MatchMode" AS ENUM ('EXACT', 'CONTAINS', 'REGEX');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PRELIMINARY', 'FINAL', 'AMENDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'MARKED_FALSE_POSITIVE', 'REOPENED');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateTable
CREATE TABLE "monitor_rule" (
    "id" UUID NOT NULL,
    "keyword" VARCHAR(255) NOT NULL,
    "level" "MonitorLevel" NOT NULL,
    "match_field" "MatchField" NOT NULL,
    "match_mode" "MatchMode" NOT NULL DEFAULT 'CONTAINS',
    "category" VARCHAR(100),
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rule_group_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100) NOT NULL,

    CONSTRAINT "monitor_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_record" (
    "id" UUID NOT NULL,
    "study_accession_no" VARCHAR(64) NOT NULL,
    "report_id" VARCHAR(64) NOT NULL,
    "report_version" INTEGER NOT NULL DEFAULT 1,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "patient_name" VARCHAR(100),
    "patient_id_masked" VARCHAR(50),
    "inpatient_no" VARCHAR(64),
    "department" VARCHAR(100),
    "study_description" VARCHAR(255),
    "study_time" TIMESTAMPTZ(6),
    "current_level" "MonitorLevel" NOT NULL DEFAULT 'UNCLASSIFIED',
    "first_matched_at" TIMESTAMPTZ(6),
    "last_matched_at" TIMESTAMPTZ(6),
    "report_status" "ReportStatus" NOT NULL DEFAULT 'UNKNOWN',
    "handling_status" "HandlingStatus" NOT NULL DEFAULT 'PENDING',
    "report_text_cache" TEXT,
    "report_text_cache_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "monitor_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_match" (
    "id" UUID NOT NULL,
    "monitor_record_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "keyword" VARCHAR(255) NOT NULL,
    "level" "MonitorLevel" NOT NULL,
    "matched_field" "MatchField" NOT NULL,
    "context_snippet" VARCHAR(500) NOT NULL,
    "report_version" INTEGER NOT NULL,
    "matched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "sync_job_log" (
    "id" UUID NOT NULL,
    "job_name" VARCHAR(100) NOT NULL,
    "cursor_start" VARCHAR(255),
    "cursor_end" VARCHAR(255),
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "status" "SyncJobStatus" NOT NULL DEFAULT 'RUNNING',
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "error_summary" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_job_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitor_rule_level_is_enabled_idx" ON "monitor_rule"("level", "is_enabled");

-- CreateIndex
CREATE INDEX "monitor_rule_rule_group_id_idx" ON "monitor_rule"("rule_group_id");

-- CreateIndex
CREATE INDEX "monitor_rule_category_idx" ON "monitor_rule"("category");

-- CreateIndex
CREATE INDEX "monitor_record_current_level_idx" ON "monitor_record"("current_level");

-- CreateIndex
CREATE INDEX "monitor_record_department_idx" ON "monitor_record"("department");

-- CreateIndex
CREATE INDEX "monitor_record_report_status_idx" ON "monitor_record"("report_status");

-- CreateIndex
CREATE INDEX "monitor_record_handling_status_idx" ON "monitor_record"("handling_status");

-- CreateIndex
CREATE INDEX "monitor_record_study_time_idx" ON "monitor_record"("study_time");

-- CreateIndex
CREATE INDEX "monitor_record_last_matched_at_idx" ON "monitor_record"("last_matched_at");

-- CreateIndex
CREATE INDEX "monitor_record_study_accession_no_report_id_idx" ON "monitor_record"("study_accession_no", "report_id");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_record_study_accession_no_report_id_report_version_key" ON "monitor_record"("study_accession_no", "report_id", "report_version");

-- CreateIndex
CREATE INDEX "monitor_match_monitor_record_id_idx" ON "monitor_match"("monitor_record_id");

-- CreateIndex
CREATE INDEX "monitor_match_rule_id_idx" ON "monitor_match"("rule_id");

-- CreateIndex
CREATE INDEX "monitor_match_level_idx" ON "monitor_match"("level");

-- CreateIndex
CREATE INDEX "monitor_match_matched_at_idx" ON "monitor_match"("matched_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_match_monitor_record_id_rule_id_matched_field_keywo_key" ON "monitor_match"("monitor_record_id", "rule_id", "matched_field", "keyword", "report_version");

-- CreateIndex
CREATE INDEX "monitor_action_monitor_record_id_occurred_at_idx" ON "monitor_action"("monitor_record_id", "occurred_at");

-- CreateIndex
CREATE INDEX "monitor_action_action_type_idx" ON "monitor_action"("action_type");

-- CreateIndex
CREATE INDEX "monitor_action_occurred_at_idx" ON "monitor_action"("occurred_at");

-- CreateIndex
CREATE INDEX "sync_job_log_job_name_started_at_idx" ON "sync_job_log"("job_name", "started_at");

-- CreateIndex
CREATE INDEX "sync_job_log_status_idx" ON "sync_job_log"("status");

-- AddForeignKey
ALTER TABLE "monitor_match" ADD CONSTRAINT "monitor_match_monitor_record_id_fkey" FOREIGN KEY ("monitor_record_id") REFERENCES "monitor_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_match" ADD CONSTRAINT "monitor_match_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "monitor_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_action" ADD CONSTRAINT "monitor_action_monitor_record_id_fkey" FOREIGN KEY ("monitor_record_id") REFERENCES "monitor_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;
