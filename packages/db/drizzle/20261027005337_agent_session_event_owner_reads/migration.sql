UPDATE `agent_session_events` SET `source_at` = strftime('%Y-%m-%dT%H:%M:%fZ', `source_at`);
CREATE INDEX `idx_agent_session_events_org_user_source_at` ON `agent_session_events` (`organization_id`,`user_id`,`source_at`,`id`);
