CREATE TABLE `graph_projection_maintenance_runs` (
	`id` text PRIMARY KEY,
	`runtime_environment` text NOT NULL,
	`organization_id` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`workflow_id` text NOT NULL UNIQUE,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error` text,
	`cancel_reason` text,
	`cancel_requested_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_graph_projection_maintenance_org_idempotency` ON `graph_projection_maintenance_runs` (`runtime_environment`,`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_maintenance_org_status` ON `graph_projection_maintenance_runs` (`runtime_environment`,`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_maintenance_status_updated` ON `graph_projection_maintenance_runs` (`runtime_environment`,`status`,`updated_at`,`id`);