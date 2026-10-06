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
	`connection_scope` text DEFAULT 'tenant' NOT NULL,
	`personal_owner_user_id` text,
	`workspace_id` text,
	`workspace_resource_id` text,
	`delegation_id` text,
	`execution_tool_id` text,
	`resource_delegation_ids` text DEFAULT '[]' NOT NULL,
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
CREATE TABLE `personal_resource_delegations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_revision` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`connection_instance_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`account_subject` text NOT NULL,
	`grant_fingerprint` text NOT NULL,
	`required_scopes` text NOT NULL,
	`operations` text NOT NULL,
	`tool_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `calendar_coordinator_configurations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`mode` text NOT NULL,
	`configuration` text NOT NULL,
	`ownership_seed` text NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`last_receipt` text,
	`last_successful_reconcile_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_calendar_coordinator_configurations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_calendar_coordinator_configurations_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `calendar_coordinator_mirrors` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`configuration_id` text NOT NULL,
	`source_key` text NOT NULL,
	`destination_key` text NOT NULL,
	`mirror` text NOT NULL,
	CONSTRAINT `fk_calendar_coordinator_mirrors_configuration_id_calendar_coordinator_configurations_id_fk` FOREIGN KEY (`configuration_id`) REFERENCES `calendar_coordinator_configurations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `calendar_coordinator_mutations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`configuration_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`action_id` text NOT NULL,
	`state` text NOT NULL,
	`mutation` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_calendar_coordinator_mutations_configuration_id_calendar_coordinator_configurations_id_fk` FOREIGN KEY (`configuration_id`) REFERENCES `calendar_coordinator_configurations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `calendar_coordinator_plans` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`configuration_id` text NOT NULL,
	`configuration_revision` integer NOT NULL,
	`plan` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_calendar_coordinator_plans_configuration_id_calendar_coordinator_configurations_id_fk` FOREIGN KEY (`configuration_id`) REFERENCES `calendar_coordinator_configurations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_workspace_resources` ADD `personal_owner_user_id` text;--> statement-breakpoint
ALTER TABLE `os_workspace_resources` ADD `connection_instance_id` text;--> statement-breakpoint
ALTER TABLE `os_workspace_resources` ADD `provider_access` text;--> statement-breakpoint
ALTER TABLE `skill_runs` ADD `resource_access_envelope` text;--> statement-breakpoint
CREATE INDEX `os_gadget_state_workspace_idx` ON `os_gadget_state` (`organization_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `provider_event_channels_subscription_idx` ON `provider_event_channels` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `provider_event_deliveries_pending_idx` ON `provider_event_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_event_subscriptions_org_idx` ON `provider_event_subscriptions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `provider_event_subscriptions_due_idx` ON `provider_event_subscriptions` (`next_reconcile_at`);--> statement-breakpoint
CREATE INDEX `personal_resource_delegations_owner_org_idx` ON `personal_resource_delegations` (`organization_id`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `personal_resource_delegations_tedi_idx` ON `personal_resource_delegations` (`organization_id`,`tedi_id`);--> statement-breakpoint
CREATE INDEX `calendar_coordinator_workspace_idx` ON `calendar_coordinator_configurations` (`organization_id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_coordinator_mirror_unique` ON `calendar_coordinator_mirrors` (`configuration_id`,`source_key`,`destination_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_coordinator_action_unique` ON `calendar_coordinator_mutations` (`configuration_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `calendar_coordinator_plan_config_idx` ON `calendar_coordinator_plans` (`organization_id`,`configuration_id`);