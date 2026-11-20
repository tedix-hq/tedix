CREATE TABLE `organization_log_cutover_allowlist` (
	`organization_id` text PRIMARY KEY,
	`note` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
