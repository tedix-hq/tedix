CREATE TABLE `billing_provider_reconciliations` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`provider_resource` text DEFAULT '' NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`ledger_cost_micros` integer NOT NULL,
	`provider_cost_micros` integer NOT NULL,
	`variance_micros` integer NOT NULL,
	`usage_row_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`evidence_ref` text,
	`reconciled_by` text,
	`reconciled_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_provider_reconciliation` ON `billing_provider_reconciliations` (`provider`,`provider_resource`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_billing_provider_reconciliation_status` ON `billing_provider_reconciliations` (`status`,`period_end`);