CREATE TABLE `tedi_memory_documents` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`sections` text,
	`description` text,
	`content` text,
	`removed` integer DEFAULT false NOT NULL,
	`char_count` integer NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`change_summary` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_memory_documents_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_memory_documents_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tedi_memory_documents_version` ON `tedi_memory_documents` (`organization_id`,`tedi_id`,`kind`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `idx_tedi_memory_documents_tedi` ON `tedi_memory_documents` (`tedi_id`);