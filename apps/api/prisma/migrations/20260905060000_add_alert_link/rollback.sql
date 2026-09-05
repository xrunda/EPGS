-- Rollback for add_alert_link (issue #72).
--
-- Fully reversible: the forward migration only adds one table (plus its
-- indexes and a SET NULL foreign key to push_log) and touches no enum. No
-- other table references alert_link, so dropping it cannot violate a
-- constraint. Consequence: every issued alert link becomes unresolvable
-- immediately (the api answers 401 ALERT_LINK_INVALID) - links already sent
-- to WeCom groups turn into dead links; the template messages themselves
-- are unaffected. Also unset ALERT_LINK_BASE_URL on api + worker (or roll
-- back the application code) BEFORE running this, otherwise the next push
-- run fails to insert into the missing table and pushes without cards.

DROP TABLE IF EXISTS "alert_link";
