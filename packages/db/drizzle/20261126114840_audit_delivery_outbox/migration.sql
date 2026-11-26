CREATE TABLE `audit_delivery_outbox` (
	`id` text PRIMARY KEY,
	`ignore_duplicates` integer DEFAULT false NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`metadata` text,
	`ip_address` text,
	`user_agent` text,
	`timestamp` integer NOT NULL,
	`trace_id` text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.traceId') END) VIRTUAL
);
