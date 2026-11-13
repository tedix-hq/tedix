-- tedix: destructive-reviewed Work-Item: 6b61b348-63f1-424e-b337-81d060dceb37
-- Scope: the accepted Work explicitly requests this forward column rename.
-- Preservation: SQLite RENAME COLUMN retains every calendar id and MCP event name,
-- subscription id, status, channel and delivery; no table or row is rebuilt or deleted.
-- Rollback: stop the new application, rename resource_key back to calendar_id,
-- then restore the previous application. Live application remains operator work.
ALTER TABLE `provider_event_subscriptions` RENAME COLUMN `calendar_id` TO `resource_key`;
