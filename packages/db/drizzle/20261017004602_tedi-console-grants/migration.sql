CREATE TABLE `tedi_console_grants` (
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`workspace_ids` text NOT NULL,
	`revision` text NOT NULL,
	`granted_by` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `tedi_console_grants_pk` PRIMARY KEY(`organization_id`, `tedi_id`),
	CONSTRAINT `fk_tedi_console_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_console_grants_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
