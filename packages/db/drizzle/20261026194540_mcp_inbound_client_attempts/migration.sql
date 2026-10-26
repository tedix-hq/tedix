CREATE TABLE `mcp_inbound_client_attempts` (
	`organization_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text,
	`last_stage` text NOT NULL,
	`last_mode` text NOT NULL,
	`last_listed` integer NOT NULL,
	`last_allowed` integer NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`denied_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `mcp_inbound_client_attempts_pk` PRIMARY KEY(`organization_id`, `mcp_server_id`, `client_id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_inbound_client_attempts_org_seen_idx` ON `mcp_inbound_client_attempts` (`organization_id`,`last_seen_at`);