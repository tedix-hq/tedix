ALTER TABLE `tedi_call_costs` ADD `billing_reservation_id` text;--> statement-breakpoint
CREATE INDEX `idx_call_costs_billing_reservation` ON `tedi_call_costs` (`billing_reservation_id`);