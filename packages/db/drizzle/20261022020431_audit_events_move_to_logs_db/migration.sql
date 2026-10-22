-- Step 1 of the log move (approved 2026-10-21): audit_events leaves dry_run.
-- The hourly d1-retention tick now copies audit rows older than 30 days into
-- LOGS_DB, reads every row back and compares every column, writes the R2
-- archive copy, and only then deletes those rows from the main database.
-- keep_days matches the table floor of 30 that the engine already applied.
-- max_rows_per_run stays at its seeded value. The other tables stay dry_run.
UPDATE `d1_retention_policies`
SET `mode` = 'move_to_logs_db', `keep_days` = 30, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'audit_events';
