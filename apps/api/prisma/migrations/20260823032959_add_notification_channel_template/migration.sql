-- Migration: add_notification_channel_template (issue #52/#53)
--
-- Adds the data model for the WeCom (企业微信) webhook notification module:
--   * NotificationMsgType enum (TEXT/NEWS) - see schema.prisma doc comment
--     for the WeCom msgtype mapping and why richer types are out of scope
--   * notification_channel - push destinations (webhook URL, ciphertext only)
--   * notification_template - push content templates with {{placeholder}}
--     tokens, rendered at send time (issue #54)
--   * AuditAction.NOTIFICATION_TEST_SEND - new enum value for auditing
--     send-test operations distinctly from CONFIG_CHANGE
--
-- NOT REVERSIBLE VIA PLAIN DROP: this migration adds a value to the
-- EXISTING AuditAction enum via ALTER TYPE ... ADD VALUE. PostgreSQL has no
-- ALTER TYPE ... DROP VALUE - see rollback.sql for what "rolling back" this
-- migration actually requires (rebuilding the enum type), which is why the
-- CreateTable/CreateEnum statements below are freely reversible but the
-- AuditAction change is not a simple DROP TYPE like earlier rollback
-- scripts in this repo.
--
-- CreateEnum
CREATE TYPE "NotificationMsgType" AS ENUM ('TEXT', 'NEWS');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_TEST_SEND';

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "webhook_url_ciphertext" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100) NOT NULL,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "msg_type" "NotificationMsgType" NOT NULL,
    "title_template" VARCHAR(200),
    "content_template" TEXT NOT NULL,
    "cover_image_url" TEXT,
    "link_url" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100) NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_channel_is_enabled_idx" ON "notification_channel"("is_enabled");

-- CreateIndex
CREATE INDEX "notification_template_is_enabled_idx" ON "notification_template"("is_enabled");

-- CreateIndex
CREATE INDEX "notification_template_msg_type_idx" ON "notification_template"("msg_type");
