CREATE TABLE `embedded_contact_users` (
	`installation_id` text NOT NULL,
	`host_user_id` text NOT NULL,
	`name` text,
	`email` text,
	`role` text,
	`custom_attributes` text DEFAULT '{}' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `embedded_contact_users_pk` PRIMARY KEY(`installation_id`, `host_user_id`),
	CONSTRAINT `fk_embedded_contact_users_installation_id_provider_installations_id_fk` FOREIGN KEY (`installation_id`) REFERENCES `provider_installations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `provider_installations` ADD `company_profile` text;--> statement-breakpoint
CREATE INDEX `idx_embedded_contact_email` ON `embedded_contact_users` (`installation_id`,`email`);