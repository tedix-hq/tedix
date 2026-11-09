-- Seed the external-agent attribution policy in dry_run. Switch it to
-- move_to_logs_db only after the logs database has migration
-- 0009_external_agent_attributions. The engine keeps at least 30 days, and
-- moves only mcp_execution rows that no review evidence cites.
INSERT OR IGNORE INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`) VALUES
	('external_agent_attributions', 'dry_run', 30, 5000);
