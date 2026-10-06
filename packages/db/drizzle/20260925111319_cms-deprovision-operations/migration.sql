CREATE TABLE `cms_deprovision_operations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`database_id` text NOT NULL,
	`authoring_app_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`deleted` text DEFAULT '[]' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_cms_deprovision_operations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `cms_deprovision_operations_org_idx` ON `cms_deprovision_operations` (`organization_id`);