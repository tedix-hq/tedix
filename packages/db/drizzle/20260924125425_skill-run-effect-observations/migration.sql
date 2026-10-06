CREATE TABLE `skill_run_effect_observations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`skill_run_id` text NOT NULL,
	`work_item_id` text,
	`source` text DEFAULT 'human_attestation' NOT NULL,
	`observer_user_id` text NOT NULL,
	`observed_state` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`effect_note` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_skill_run_effect_observations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_run_effect_observations_skill_run_id_skill_runs_id_fk` FOREIGN KEY (`skill_run_id`) REFERENCES `skill_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_run_effect_observations_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skill_run_effect_observations_org_run` ON `skill_run_effect_observations` (`organization_id`,`skill_run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_run_effect_observation_user_ref` ON `skill_run_effect_observations` (`organization_id`,`skill_run_id`,`observer_user_id`,`evidence_ref`);