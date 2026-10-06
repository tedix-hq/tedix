CREATE TABLE `provider_installations` (
	`id` text PRIMARY KEY,
	`provider_organization_id` text NOT NULL,
	`provider_app_id` text NOT NULL,
	`provider_api_key_id` text NOT NULL,
	`external_tenant_id` text NOT NULL,
	`customer_organization_id` text NOT NULL,
	`primary_workspace_id` text NOT NULL,
	`primary_tedi_id` text NOT NULL,
	`allowed_origin` text NOT NULL,
	`host_tenant_argument` text NOT NULL,
	`host_tenant_namespace` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`provisioned_by` text NOT NULL,
	`provenance` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paused_at` text,
	CONSTRAINT `fk_provider_installations_provider_organization_id_organizations_id_fk` FOREIGN KEY (`provider_organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_provider_installations_provider_app_id_apps_id_fk` FOREIGN KEY (`provider_app_id`) REFERENCES `apps`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_provider_installations_provider_api_key_id_api_keys_id_fk` FOREIGN KEY (`provider_api_key_id`) REFERENCES `api_keys`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_provider_installations_customer_organization_id_organizations_id_fk` FOREIGN KEY (`customer_organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_provider_installations_primary_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`primary_workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_provider_installations_primary_tedi_id_tedis_id_fk` FOREIGN KEY (`primary_tedi_id`) REFERENCES `tedis`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "provider_installation_status_check" CHECK("status" IN ('active', 'paused')),
	CONSTRAINT "provider_installation_pause_check" CHECK(("status" = 'active' AND "paused_at" IS NULL) OR ("status" = 'paused' AND "paused_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_installation_tenant` ON `provider_installations` (`provider_organization_id`,`provider_app_id`,`external_tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_installation_credential_tenant` ON `provider_installations` (`provider_api_key_id`,`external_tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_provider_installation_customer` ON `provider_installations` (`customer_organization_id`);--> statement-breakpoint
CREATE INDEX `idx_provider_installation_tedi` ON `provider_installations` (`primary_tedi_id`);