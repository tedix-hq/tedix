CREATE TABLE `billing_settlement_cursors` (
	`name` text PRIMARY KEY,
	`after_rowid` integer NOT NULL,
	`full_sweep_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_call_costs_provider_units_queue` ON `tedi_call_costs` (`snapshot_at`,`gateway_log_id`) WHERE "tedi_call_costs"."usage_kind" IS NOT NULL;