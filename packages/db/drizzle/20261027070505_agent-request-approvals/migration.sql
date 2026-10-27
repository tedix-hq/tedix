CREATE TABLE `work_approval_executions` (
	`proposal_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`execution` text NOT NULL,
	CONSTRAINT `fk_work_approval_executions_proposal_id_work_approval_proposals_id_fk` FOREIGN KEY (`proposal_id`) REFERENCES `work_approval_proposals`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_work_approval_executions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `connection_providers` ADD `default_data_sensitivity` text DEFAULT 'confidential' NOT NULL;--> statement-breakpoint
ALTER TABLE `connection_instances` ADD `owner_team` text;--> statement-breakpoint
ALTER TABLE `connection_instances` ADD `justification` text;--> statement-breakpoint
ALTER TABLE `connection_instances` ADD `data_sensitivity` text;--> statement-breakpoint
ALTER TABLE `tedis` ADD `owner_team` text;--> statement-breakpoint
ALTER TABLE `tedis` ADD `justification` text;--> statement-breakpoint
ALTER TABLE `tedis` ADD `data_sensitivity` text;