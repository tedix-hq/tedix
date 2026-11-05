-- The first live ticks moved 100 verified rows each (1,200 rows in four hours)
-- while the main database kept growing. Raise the per-tick cap to four 500-row
-- pages; the tick's time budget still bounds each pass. Only the cap set by the
-- activation migration changes, so an operator's own cap stays.
UPDATE `d1_retention_policies`
SET `max_rows_per_run` = 2000, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'skill_run_artifacts'
	AND `mode` = 'move_to_logs_db'
	AND `max_rows_per_run` = 100;
