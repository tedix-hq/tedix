CREATE INDEX `idx_audit_events_trace_timestamp` ON `audit_events` (json_extract("metadata", '$.traceId'),`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_execution_timestamp` ON `audit_events` (json_extract("metadata", '$.executionId'),`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_org_app_timestamp` ON `audit_events` (`organization_id`,json_extract("metadata", '$.appId'),`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_org_actor_timestamp` ON `audit_events` (`organization_id`,`actor_id`,`timestamp`);