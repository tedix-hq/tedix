-- Live ticks stop at the 2,000-row cap after ~14 s while 239k expired artifact
-- rows (~477 MB) wait in main D1, about 30 hours at that pace. Head passes now
-- run before every table's sweep, so the artifact head gets about half of the
-- 60 s tick; let the time budget bound it instead of the cap. Only the cap set
-- by the earlier migration changes, so an operator's own cap stays.
UPDATE `d1_retention_policies`
SET `max_rows_per_run` = 6000, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'skill_run_artifacts'
	AND `mode` = 'move_to_logs_db'
	AND `max_rows_per_run` = 2000;
