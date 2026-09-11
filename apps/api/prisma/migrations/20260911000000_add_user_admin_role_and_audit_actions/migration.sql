-- AlterEnum
-- USER_ADMIN is a NON-REVERSIBLE enum addition (PostgreSQL has no ADD VALUE
-- ... REMOVE). IF NOT EXISTS keeps `migrate deploy` idempotent when
-- re-applied to an env that already has the value. New role for issue #78/
-- #79: manages app_user accounts and app_user_access grants via the
-- user-admin feature, kept separate from SYSTEM_ADMIN.
ALTER TYPE "AppRole" ADD VALUE IF NOT EXISTS 'USER_ADMIN';

-- AlterEnum
-- Six new AuditAction values for the user-admin feature (issue #78/#79).
-- Same non-reversible caveat as above. Populated by manual
-- AuditService.record(...) calls in the /api/users controller (issue #81),
-- mirroring the existing RULE_CREATE/RULE_UPDATE pattern.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_CREATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_ROLE_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_DISABLE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_ENABLE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_DELETE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_PASSWORD_RESET';
