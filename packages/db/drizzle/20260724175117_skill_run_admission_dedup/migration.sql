CREATE TABLE `skill_run_admission_dedup` (
	`fingerprint` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skill_run_admission_dedup_expires` ON `skill_run_admission_dedup` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_run_admission_dedup_run` ON `skill_run_admission_dedup` (`run_id`);