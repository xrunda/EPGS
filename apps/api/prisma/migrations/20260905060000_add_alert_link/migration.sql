-- Issue #72: per-level "点击查看患者列表" alert links appended to a push.
--
-- One row per (push run, level) holding a FROZEN snapshot of the
-- monitor_record ids that sat at that level inside the run's summary window,
-- reachable through an opaque token whose SHA-256 hex is the only thing
-- stored (token_hash). Holds NO patient data - ids only. See
-- apps/api/prisma/schema.prisma (model AlertLink) and docs/auth.md
-- "预警链接受限凭证". Hand-written (prisma migrate dev is interactive-only);
-- verified against the schema with `prisma migrate diff`.

-- CreateTable
CREATE TABLE "alert_link" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "level" "MonitorLevel" NOT NULL,
    "window_date" VARCHAR(10) NOT NULL,
    "push_log_id" UUID,
    "record_ids" UUID[],
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_link_token_hash_key" ON "alert_link"("token_hash");

-- CreateIndex
CREATE INDEX "alert_link_expires_at_idx" ON "alert_link"("expires_at");

-- CreateIndex
CREATE INDEX "alert_link_push_log_id_idx" ON "alert_link"("push_log_id");

-- AddForeignKey
ALTER TABLE "alert_link" ADD CONSTRAINT "alert_link_push_log_id_fkey" FOREIGN KEY ("push_log_id") REFERENCES "push_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;
