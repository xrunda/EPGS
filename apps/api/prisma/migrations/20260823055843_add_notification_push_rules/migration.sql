-- CreateEnum
CREATE TYPE "NotificationPushTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "NotificationPushStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationPushDeliveryStatus" AS ENUM ('SUCCESS', 'FAILED');

-- AlterEnum
-- NOTIFICATION_RULE_RUN is a NON-REVERSIBLE enum addition (PostgreSQL has no
-- ADD VALUE ... REMOVE). IF NOT EXISTS keeps `migrate deploy` idempotent when
-- re-applied to an env that already has the value.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NOTIFICATION_RULE_RUN';

-- CreateTable
CREATE TABLE "notification_rule" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "cron" VARCHAR(100) NOT NULL,
    "template_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100) NOT NULL,

    CONSTRAINT "notification_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rule_channel" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_rule_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_log" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "window_date" VARCHAR(10) NOT NULL,
    "trigger" "NotificationPushTrigger" NOT NULL,
    "status" "NotificationPushStatus",
    "error_summary" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_delivery" (
    "id" UUID NOT NULL,
    "push_log_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "status" "NotificationPushDeliveryStatus" NOT NULL,
    "wecom_err_code" INTEGER,
    "wecom_err_msg" VARCHAR(255),
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_rule_is_enabled_idx" ON "notification_rule"("is_enabled");

-- CreateIndex
CREATE INDEX "notification_rule_template_id_idx" ON "notification_rule"("template_id");

-- CreateIndex
CREATE INDEX "notification_rule_channel_channel_id_idx" ON "notification_rule_channel"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_rule_channel_rule_id_channel_id_key" ON "notification_rule_channel"("rule_id", "channel_id");

-- CreateIndex
CREATE INDEX "push_log_rule_id_started_at_idx" ON "push_log"("rule_id", "started_at");

-- CreateIndex
CREATE INDEX "push_log_trigger_idx" ON "push_log"("trigger");

-- CreateIndex
CREATE INDEX "push_delivery_push_log_id_idx" ON "push_delivery"("push_log_id");

-- CreateIndex
CREATE INDEX "push_delivery_channel_id_idx" ON "push_delivery"("channel_id");

-- AddForeignKey
ALTER TABLE "notification_rule" ADD CONSTRAINT "notification_rule_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_channel" ADD CONSTRAINT "notification_rule_channel_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "notification_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_channel" ADD CONSTRAINT "notification_rule_channel_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_log" ADD CONSTRAINT "push_log_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "notification_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_delivery" ADD CONSTRAINT "push_delivery_push_log_id_fkey" FOREIGN KEY ("push_log_id") REFERENCES "push_log"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_delivery" ADD CONSTRAINT "push_delivery_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PushRule scheduled idempotency (issue: push rules): a SCHEDULED run may
-- happen at most once per (rule, window_date). This is a PARTIAL unique
-- index - MANUAL "run now" must stay freely repeatable within a day, so the
-- index deliberately covers only `trigger = 'SCHEDULED'` rows. Prisma
-- @@unique cannot express a WHERE clause, so this index is hand-written and
-- is NOT representable in schema.prisma: if `prisma migrate dev` ever
-- proposes dropping it as drift, re-apply it by hand (see PushLog's schema
-- comment).
CREATE UNIQUE INDEX "uq_push_log_scheduled_dedup" ON "push_log"("rule_id", "window_date") WHERE "trigger" = 'SCHEDULED';
