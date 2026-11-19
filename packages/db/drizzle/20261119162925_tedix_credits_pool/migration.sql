CREATE TABLE `billing_credit_caps` (
	`organization_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`monthly_cap_credits` integer NOT NULL,
	`updated_by` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `billing_credit_caps_pk` PRIMARY KEY(`organization_id`, `subject_kind`, `subject_key`),
	CONSTRAINT `fk_billing_credit_caps_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_billing_credit_cap_nonnegative" CHECK("monthly_cap_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE `billing_credit_consumptions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`user_id` text,
	`kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`credits` integer NOT NULL,
	`included_credits` integer NOT NULL,
	`top_up_credits` integer NOT NULL,
	`payg_credits` integer NOT NULL,
	`payg_charge_micros` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_billing_credit_consumptions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_credit_consumptions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT "chk_billing_credit_consumption_split" CHECK("credits" >= 0 AND "included_credits" >= 0 AND "top_up_credits" >= 0 AND "payg_credits" >= 0 AND "included_credits" + "top_up_credits" + "payg_credits" = "credits" AND "payg_charge_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE `billing_credit_meter_outbox` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`consumption_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_environment` text NOT NULL,
	`event_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_expires_at` text,
	`stripe_event_id` text,
	`last_error` text,
	`sent_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_credit_meter_outbox_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_credit_meter_outbox_consumption_id_billing_credit_consumptions_id_fk` FOREIGN KEY (`consumption_id`) REFERENCES `billing_credit_consumptions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_credit_notices` (
	`organization_id` text NOT NULL,
	`period_start` text NOT NULL,
	`threshold` integer NOT NULL,
	`reached_at` text NOT NULL,
	CONSTRAINT `billing_credit_notices_pk` PRIMARY KEY(`organization_id`, `period_start`, `threshold`),
	CONSTRAINT `fk_billing_credit_notices_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_billing_credit_notice_threshold" CHECK("threshold" IN (80, 100))
);
--> statement-breakpoint
CREATE TABLE `billing_credit_top_ups` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`credits` integer NOT NULL,
	`consumed_credits` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`pack_version_id` text,
	`idempotency_key` text NOT NULL,
	`expires_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_credit_top_ups_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_credit_top_ups_pack_version_id_billing_top_up_pack_versions_id_fk` FOREIGN KEY (`pack_version_id`) REFERENCES `billing_top_up_pack_versions`(`id`),
	CONSTRAINT "chk_billing_credit_top_up_amounts" CHECK("credits" > 0 AND "consumed_credits" >= 0 AND "consumed_credits" <= "credits")
);
--> statement-breakpoint
CREATE TABLE `billing_credit_usage_totals` (
	`organization_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`ai_credits` integer DEFAULT 0 NOT NULL,
	`code_run_credits` integer DEFAULT 0 NOT NULL,
	`service_credits` integer DEFAULT 0 NOT NULL,
	`included_credits` integer DEFAULT 0 NOT NULL,
	`top_up_credits` integer DEFAULT 0 NOT NULL,
	`payg_credits` integer DEFAULT 0 NOT NULL,
	`payg_charge_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `billing_credit_usage_totals_pk` PRIMARY KEY(`organization_id`, `period_start`, `subject_kind`, `subject_key`),
	CONSTRAINT `fk_billing_credit_usage_totals_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_top_up_pack_versions` (
	`id` text PRIMARY KEY,
	`pack_key` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'eur' NOT NULL,
	`price_micros` integer NOT NULL,
	`credits` integer NOT NULL,
	`valid_months` integer NOT NULL,
	`stripe_environment` text NOT NULL,
	`stripe_lookup_key` text NOT NULL,
	`effective_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "chk_billing_top_up_pack_positive" CHECK("price_micros" > 0 AND "credits" > 0 AND "valid_months" > 0)
);
--> statement-breakpoint
ALTER TABLE `billing_accounts` ADD `included_credits_override` integer;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` ADD `included_monthly_credits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` ADD `credit_fx` text;--> statement-breakpoint
ALTER TABLE `billing_service_credit_reservations` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `billing_usage_charges` ADD `credits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_usage_reservations` ADD `credits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_usage_reservations` ADD `user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_consumption_source` ON `billing_credit_consumptions` (`kind`,`source_ref`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_consumption_org_period` ON `billing_credit_consumptions` (`organization_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_meter_outbox_idempotency` ON `billing_credit_meter_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_meter_outbox_consumption` ON `billing_credit_meter_outbox` (`consumption_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_meter_outbox_retry` ON `billing_credit_meter_outbox` (`stripe_environment`,`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_top_up_idempotency` ON `billing_credit_top_ups` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_top_up_org_expiry` ON `billing_credit_top_ups` (`organization_id`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_top_up_pack_version` ON `billing_top_up_pack_versions` (`pack_key`,`version`,`stripe_environment`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_top_up_pack_lookup` ON `billing_top_up_pack_versions` (`stripe_environment`,`stripe_lookup_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_top_up_pack_active` ON `billing_top_up_pack_versions` (`stripe_environment`,`status`,`effective_at`);