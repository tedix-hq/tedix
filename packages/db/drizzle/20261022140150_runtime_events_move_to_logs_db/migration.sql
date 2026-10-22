-- Runtime event readers now merge main D1 with LOGS_DB, and the retention
-- engine verifies every copied row and its R2 archive before deleting main.
-- Preserve an operator's explicit `off` override while activating seeded
-- dry-run policies at their existing 14-day keep windows.
UPDATE `d1_retention_policies`
SET `mode` = 'move_to_logs_db', `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` IN ('tedi_runtime_events', 'kernel_runtime_events')
	AND `mode` = 'dry_run';
