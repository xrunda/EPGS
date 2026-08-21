-- CreateEnum
CREATE TYPE "AppRole" AS ENUM ('VIEWER', 'RULE_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('EXAM_LIST', 'EXAM_DETAIL', 'RULE_CREATE', 'RULE_UPDATE', 'RULE_IMPORT', 'CONFIG_CHANGE', 'AUDIT_VIEW', 'LOGIN');

-- CreateTable
CREATE TABLE "app_user_access" (
    "username" VARCHAR(100) NOT NULL,
    "roles" "AppRole"[],
    "department_scope" TEXT[],
    "patient_detail" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_access_pkey" PRIMARY KEY ("username")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_username" VARCHAR(100),
    "actor_role" "AppRole" NOT NULL,
    "action" "AuditAction" NOT NULL,
    "resource_type" VARCHAR(100) NOT NULL,
    "resource_id" UUID,
    "department" VARCHAR(100),
    "meta" JSONB,
    "ip" VARCHAR(64),
    "correlation_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_username_created_at_idx" ON "audit_log"("actor_username", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_department_created_at_idx" ON "audit_log"("department", "created_at");
