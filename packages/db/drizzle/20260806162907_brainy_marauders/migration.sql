CREATE TABLE `os_instance_deployments` (
	`id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`from_release_id` text,
	`to_release_id` text,
	`idempotency_key` text NOT NULL,
	`error` text,
	`requested_by_type` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`requested_by_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `fk_os_instance_deployments_instance_id_os_instances_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `os_instances`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_instance_gatekeepers` (
	`id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`package_name` text NOT NULL,
	`vendor_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`status` text DEFAULT 'pending_credentials' NOT NULL,
	`auth_order` integer,
	`credentials_installed_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_instance_gatekeepers_instance_id_os_instances_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `os_instances`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_instances` (
	`id` text PRIMARY KEY,
	`org_slug` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`public_base_url` text NOT NULL,
	`cloudflare_account_id` text NOT NULL,
	`route_kind` text DEFAULT 'custom_domain' NOT NULL,
	`pinned_release_id` text,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`tedix_org` text,
	`active_deployment_id` text,
	`latest_deployment_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`suspended_at` text,
	CONSTRAINT `fk_os_instances_org_slug_organizations_slug_fk` FOREIGN KEY (`org_slug`) REFERENCES `organizations`(`slug`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_instance_deployments_idempotency_unique` ON `os_instance_deployments` (`instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `os_instance_deployments_instance_created_idx` ON `os_instance_deployments` (`instance_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_instance_deployments_status_idx` ON `os_instance_deployments` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_instance_gatekeepers_instance_vendor_unique` ON `os_instance_gatekeepers` (`instance_id`,`vendor_id`);--> statement-breakpoint
CREATE INDEX `os_instance_gatekeepers_status_idx` ON `os_instance_gatekeepers` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_instances_slug_unique` ON `os_instances` (`slug`);--> statement-breakpoint
CREATE INDEX `os_instances_org_slug_idx` ON `os_instances` (`org_slug`);--> statement-breakpoint
CREATE INDEX `os_instances_status_idx` ON `os_instances` (`status`);