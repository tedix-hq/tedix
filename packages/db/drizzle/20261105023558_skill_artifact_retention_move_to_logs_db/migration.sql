-- Start with 100 verified moves per tick while production readers are checked.
-- Preserve the keep window and explicit operator overrides.
UPDATE `d1_retention_policies`
SET `mode` = 'move_to_logs_db', `max_rows_per_run` = 100,
	`updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'skill_run_artifacts' AND `mode` = 'dry_run';
