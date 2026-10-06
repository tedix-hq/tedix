ALTER TABLE `workstation_leases` ADD `body_instance_id` text;--> statement-breakpoint
ALTER TABLE `workstation_leases` ADD `body_instance_name` text;--> statement-breakpoint
ALTER TABLE `workstation_leases` ADD `body_instance_observed_at` text;--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_body_instance` ON `workstation_leases` (`body_instance_name`);