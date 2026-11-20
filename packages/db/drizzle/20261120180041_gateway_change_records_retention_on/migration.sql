-- The change-ledger owner wants the verified move on: whole sealed,
-- bundled checkpoints past 90 days move to the logs database.
UPDATE `d1_retention_policies`
SET `mode` = 'move_to_logs_db', `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'gateway_change_records';
