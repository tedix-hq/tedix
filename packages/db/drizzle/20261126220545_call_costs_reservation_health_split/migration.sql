CREATE INDEX `idx_call_costs_reservation_health` ON `tedi_call_costs` (`billing_reservation_id`,`success`,`org_id`,`gateway_log_id`,`snapshot_at`);
--> statement-breakpoint
DROP INDEX `idx_call_costs_billing_reservation`;
--> statement-breakpoint
CREATE INDEX `idx_call_costs_billing_reservation` ON `tedi_call_costs` (`billing_reservation_id`);
