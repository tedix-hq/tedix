CREATE TABLE `tedi_provisional_outcomes` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`org_id` text NOT NULL,
	`conversation_id` text,
	`run_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_tedi_provisional_outcomes_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_provisional_outcomes_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_tedi_provisional_outcomes_org_created` ON `tedi_provisional_outcomes` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_provisional_outcomes_tedi_created` ON `tedi_provisional_outcomes` (`tedi_id`,`created_at`);