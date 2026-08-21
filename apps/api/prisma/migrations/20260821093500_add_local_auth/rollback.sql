-- Destructive rollback for Issue #31. Run only after confirming local
-- accounts are no longer needed or have been backed up.
DROP TABLE IF EXISTS "app_user";
