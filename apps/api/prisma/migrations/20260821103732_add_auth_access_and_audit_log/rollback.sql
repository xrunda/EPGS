-- Destructive rollback for Issue #13. Drops the access-grant table and the
-- audit trail (and their enum types). Run only after confirming the audit
-- history and access assignments are no longer needed or have been backed up.
DROP TABLE IF EXISTS "audit_log";
DROP TABLE IF EXISTS "app_user_access";
DROP TYPE IF EXISTS "AuditAction";
DROP TYPE IF EXISTS "AppRole";
