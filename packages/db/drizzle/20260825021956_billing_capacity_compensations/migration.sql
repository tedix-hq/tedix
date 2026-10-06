PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_billing_capacity_allocations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`pack_version_id` text,
	`budget_day` text NOT NULL,
	`token_amount` integer DEFAULT 0 NOT NULL,
	`spend_amount_micros` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`idempotency_key` text NOT NULL,
	`stripe_environment` text NOT NULL,
	`expires_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_capacity_allocations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_capacity_allocations_pack_version_id_billing_inference_capacity_pack_versions_id_fk` FOREIGN KEY (`pack_version_id`) REFERENCES `billing_inference_capacity_pack_versions`(`id`),
	CONSTRAINT "chk_billing_capacity_allocation_direction" CHECK(("token_amount" > 0 OR "spend_amount_micros" > 0) OR ("token_amount" < 0 OR "spend_amount_micros" < 0)),
	CONSTRAINT "chk_billing_capacity_allocation_same_direction" CHECK(("token_amount" >= 0 AND "spend_amount_micros" >= 0) OR ("token_amount" <= 0 AND "spend_amount_micros" <= 0))
);
--> statement-breakpoint
INSERT INTO `__new_billing_capacity_allocations`(`id`, `organization_id`, `pack_version_id`, `budget_day`, `token_amount`, `spend_amount_micros`, `source_type`, `source_ref`, `idempotency_key`, `stripe_environment`, `expires_at`, `metadata`, `created_at`) SELECT `id`, `organization_id`, `pack_version_id`, `budget_day`, `token_amount`, `spend_amount_micros`, `source_type`, `source_ref`, `idempotency_key`, `stripe_environment`, `expires_at`, `metadata`, `created_at` FROM `billing_capacity_allocations`;--> statement-breakpoint
DROP TABLE `billing_capacity_allocations`;--> statement-breakpoint
ALTER TABLE `__new_billing_capacity_allocations` RENAME TO `billing_capacity_allocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_capacity_allocation_idempotency` ON `billing_capacity_allocations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_capacity_allocation_active` ON `billing_capacity_allocations` (`organization_id`,`stripe_environment`,`budget_day`,`expires_at`);
