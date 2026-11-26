-- Drizzle RC.5 snapshots changed index columns but does not emit their rebuild.
DROP INDEX `idx_billing_reservation_newest`;
--> statement-breakpoint
CREATE INDEX `idx_billing_reservation_newest` ON `billing_usage_reservations` (`created_at`, `id`) WHERE +created_at >= '';
--> statement-breakpoint
DROP INDEX `idx_provider_execution_authorized`;
--> statement-breakpoint
CREATE INDEX `idx_provider_execution_authorized` ON `provider_execution_attempts` (`authorized_at`, `billing_reservation_id`);
--> statement-breakpoint
DROP INDEX `idx_call_costs_billing_reservation`;
--> statement-breakpoint
CREATE INDEX `idx_call_costs_billing_reservation` ON `tedi_call_costs` (`billing_reservation_id`, `success`, `org_id`, `gateway_log_id`, `snapshot_at`);
