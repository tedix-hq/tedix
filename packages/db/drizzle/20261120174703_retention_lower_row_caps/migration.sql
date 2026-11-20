-- Smaller per-run moves after main D1 returned 7429 to live reads on
-- 20 Nov 2026. A run now moves at most 1,000 rows per table, with a
-- pause after each 500-row page.
UPDATE `d1_retention_policies`
SET `max_rows_per_run` = 1000, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` IN ('external_agent_attributions', 'tedi_call_costs',
  'kernel_request_events', 'platform_cron_executions', 'tedi_usage_events',
  'widget_events', 'workflow_run_ledger');
