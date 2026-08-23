-- Rollback for add_notification_push_rules (issue: push rules).
--
-- The table/enum-creation half of the forward migration is freely
-- reversible with plain DROP statements. The AuditAction change is NOT:
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`, so removing
-- 'NOTIFICATION_RULE_RUN' from AuditAction requires rebuilding the enum
-- type (create a new type without the value, repoint every column that
-- uses it, drop the old type, rename the new one into place). This is only
-- safe if NO audit_log row currently has action = 'NOTIFICATION_RULE_RUN'
-- - if any exist, decide whether to delete those rows (losing audit
-- history) or keep the enum value and skip this rollback. Same pattern as
-- the add_notification_channel_template rollback.
--
-- Steps:
--   1. Drop the four new tables (safe: they carry no data other rows
--      reference, per the @@map names in schema.prisma). Dropping
--      push_log also drops the hand-written partial unique index
--      uq_push_log_scheduled_dedup - no separate DROP INDEX needed.
--   2. Drop the three new enums (safe: no longer referenced once their
--      tables are gone). NOTE: PG refuses to DROP TYPE while any table
--      column still uses it, so run these AFTER the DROP TABLEs.
--   3. Rebuild AuditAction without NOTIFICATION_RULE_RUN, but ONLY run
--      this block after confirming no audit_log row uses that value:
--
--        SELECT count(*) FROM audit_log WHERE action = 'NOTIFICATION_RULE_RUN';
--        -- must return 0 before proceeding
--
--      If it returns 0, run:
--
--        ALTER TYPE "AuditAction" RENAME TO "AuditAction_old";
--        CREATE TYPE "AuditAction" AS ENUM (
--          'EXAM_LIST', 'EXAM_DETAIL', 'RULE_CREATE', 'RULE_UPDATE',
--          'RULE_IMPORT', 'CONFIG_CHANGE', 'AUDIT_VIEW', 'LOGIN',
--          'NOTIFICATION_TEST_SEND'
--        );
--        ALTER TABLE "audit_log"
--          ALTER COLUMN "actor_role" DROP DEFAULT,
--          ALTER COLUMN "action" TYPE "AuditAction"
--            USING ("action"::text::"AuditAction"),
--          ALTER COLUMN "actor_role" TYPE "AppRole"
--            USING ("actor_role"::text::"AppRole");
--        DROP TYPE "AuditAction_old";
--
-- Step 3 is deliberately NOT executed unconditionally by this script -
-- run the count check first and decide manually, per this repo's existing
-- rollback convention of documenting rather than blindly automating
-- destructive/irreversible steps (see the add_notification_channel_template
-- rollback header).

DROP TABLE IF EXISTS "push_delivery";
DROP TABLE IF EXISTS "push_log";
DROP TABLE IF EXISTS "notification_rule_channel";
DROP TABLE IF EXISTS "notification_rule";
DROP TYPE IF EXISTS "NotificationPushDeliveryStatus";
DROP TYPE IF EXISTS "NotificationPushStatus";
DROP TYPE IF EXISTS "NotificationPushTrigger";

-- AuditAction enum rebuild (step 3 above) intentionally left as a manual,
-- reviewed operation - see the comment block above for the exact SQL.
