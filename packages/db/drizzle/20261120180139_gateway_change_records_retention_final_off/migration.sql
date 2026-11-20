-- Final decision (DB and change-ledger owners, 20 Nov 2026): change records
-- leave main only into the per-organization log store (Work c5642d65).
UPDATE `d1_retention_policies`
SET `mode` = 'off', `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'gateway_change_records';
