-- Logs migration 0017 adds the table to every logs database. The nightly
-- prune of these records stops in the same release.
INSERT INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`)
VALUES ('gateway_change_records', 'move_to_logs_db', 90, 1000)
ON CONFLICT (`table_name`) DO NOTHING;
