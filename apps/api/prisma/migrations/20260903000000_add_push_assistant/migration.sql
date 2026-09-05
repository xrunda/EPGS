-- CreateEnum
CREATE TYPE "AssistantEventType" AS ENUM ('KEYWORD_HIT', 'PUSH_DONE');

-- CreateTable
CREATE TABLE "assistant_heartbeat" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "next_trigger_at" TIMESTAMPTZ(6),
    "running_since" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assistant_heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_event" (
    "id" UUID NOT NULL,
    "type" "AssistantEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "assistant_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_event_occurred_at_idx" ON "assistant_event"("occurred_at");

