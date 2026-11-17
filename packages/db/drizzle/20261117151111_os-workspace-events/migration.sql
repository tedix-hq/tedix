CREATE TABLE `os_workspace_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `os_workspace_events_workspace_seq_idx` ON `os_workspace_events` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `os_workspace_events_created_idx` ON `os_workspace_events` (`created_at`);