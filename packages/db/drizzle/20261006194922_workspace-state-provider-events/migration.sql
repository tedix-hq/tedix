CREATE TABLE `os_gadget_state` (
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`key` text NOT NULL,
	`revision` integer NOT NULL,
	`value` text,
	`deleted` integer NOT NULL,
	`access_envelope` text NOT NULL,
	`execution_id` text NOT NULL,
	`last_mutation_id` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `os_gadget_state_pk` PRIMARY KEY(`organization_id`, `gadget_id`, `key`),
	CONSTRAINT `fk_os_gadget_state_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadget_state_gadget_id_os_gadgets_id_fk` FOREIGN KEY (`gadget_id`) REFERENCES `os_gadgets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_gadget_state_mutations` (
	`organization_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`digest` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	CONSTRAINT `os_gadget_state_mutations_pk` PRIMARY KEY(`organization_id`, `gadget_id`, `idempotency_key`),
	CONSTRAINT `fk_os_gadget_state_mutations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadget_state_mutations_gadget_id_os_gadgets_id_fk` FOREIGN KEY (`gadget_id`) REFERENCES `os_gadgets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `provider_event_channels` (
	`id` text PRIMARY KEY,
	`subscription_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`provider_channel_id` text,
	`resource_id` text,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_event_deliveries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE TABLE `provider_event_subscriptions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`adapter` text NOT NULL,
	`provider_id` text NOT NULL,
	`connection_instance_id` text,
	`calendar_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_revision` integer NOT NULL,
	`delivery_mode` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` text,
	`next_reconcile_at` text NOT NULL,
	`last_notification_at` text,
	`last_dispatch_at` text,
	`last_error` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `os_gadget_state_workspace_idx` ON `os_gadget_state` (`organization_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `provider_event_channels_subscription_idx` ON `provider_event_channels` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `provider_event_deliveries_pending_idx` ON `provider_event_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_event_subscriptions_org_idx` ON `provider_event_subscriptions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `provider_event_subscriptions_due_idx` ON `provider_event_subscriptions` (`next_reconcile_at`);