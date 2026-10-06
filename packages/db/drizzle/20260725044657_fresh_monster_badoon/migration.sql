ALTER TABLE `tedi_call_costs` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `work_item_id` text;--> statement-breakpoint
CREATE INDEX `idx_call_costs_run` ON `tedi_call_costs` (`run_id`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `idx_call_costs_work_item` ON `tedi_call_costs` (`work_item_id`,`snapshot_at`);