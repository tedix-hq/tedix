ALTER TABLE `work_budget_envelopes` ADD `mode` text DEFAULT 'stop' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_budget_envelopes` ADD `alerted_percent` integer DEFAULT 0 NOT NULL;