CREATE TABLE `skill_workflow_sources` (
	`skill_id` text NOT NULL,
	`sha256` text NOT NULL,
	`workflow_source` text NOT NULL,
	CONSTRAINT `skill_workflow_sources_pk` PRIMARY KEY(`skill_id`, `sha256`),
	CONSTRAINT `fk_skill_workflow_sources_skill_id_skill_entries_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `skill_runs` ADD `workflow_source_hash` text;