-- Change records stay in main until the per-organization log store
-- (Work c5642d65) takes them; the move engine leaves this table alone.
UPDATE `d1_retention_policies`
SET `mode` = 'off', `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'gateway_change_records';
