CREATE TABLE `billing_gateway_reconciliations` (
	`id` text PRIMARY KEY,
	`day` text NOT NULL,
	`gateway_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`ledger_cost_micros` integer NOT NULL,
	`gateway_cost_micros` integer NOT NULL,
	`difference_micros` integer NOT NULL,
	`ledger_row_count` integer DEFAULT 0 NOT NULL,
	`gateway_request_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`computed_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_gateway_reconciliation` ON `billing_gateway_reconciliations` (`day`,`gateway_id`,`provider`,`model`);--> statement-breakpoint
CREATE INDEX `idx_billing_gateway_reconciliation_status` ON `billing_gateway_reconciliations` (`status`,`day`);