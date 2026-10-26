CREATE TABLE `connection_provider_settings` (
	`organization_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_mode` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `connection_provider_settings_pk` PRIMARY KEY(`organization_id`, `provider_id`),
	CONSTRAINT `fk_connection_provider_settings_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
