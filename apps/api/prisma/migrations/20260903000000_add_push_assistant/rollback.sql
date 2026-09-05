-- Rollback for add_push_assistant (issue #70).
--
-- Fully reversible: the forward migration only adds two standalone tables
-- (no foreign keys in either direction) and one enum used solely by
-- assistant_event.type. Dropping them loses the push assistant's heartbeat
-- row and its activity feed (counts / keyword text / durations only - never
-- patient data), which the worker rebuilds from scratch on its next tick.
-- Roll the application code back (or stop the worker) BEFORE running this,
-- otherwise the next heartbeat write fails on the missing table. Drop the
-- tables first: PG refuses DROP TYPE while a column still uses the enum.

DROP TABLE IF EXISTS "assistant_event";
DROP TABLE IF EXISTS "assistant_heartbeat";
DROP TYPE IF EXISTS "AssistantEventType";
