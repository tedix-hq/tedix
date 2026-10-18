CREATE TABLE `decision_exposures` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`card_id` text NOT NULL,
	`session_id` text NOT NULL,
	`class_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`context` text NOT NULL,
	`occurred_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_decision_exposures_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `decision_outcome_labels` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`card_id` text NOT NULL,
	`class_id` text NOT NULL,
	`window` text NOT NULL,
	`outcome` text NOT NULL,
	`delayed` text,
	`observed_at` text NOT NULL,
	`due_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_decision_outcome_labels_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_decision_exposure_org_actor_event` ON `decision_exposures` (`organization_id`,`actor_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_decision_exposure_org_actor_card` ON `decision_exposures` (`organization_id`,`actor_id`,`card_id`);--> statement-breakpoint
CREATE INDEX `idx_decision_exposure_expiry` ON `decision_exposures` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_decision_label_org_actor_receipt_window` ON `decision_outcome_labels` (`organization_id`,`actor_id`,`card_id`,`window`,`id`);--> statement-breakpoint
CREATE INDEX `idx_decision_label_org_class` ON `decision_outcome_labels` (`organization_id`,`actor_id`,`class_id`,`window`);--> statement-breakpoint
CREATE INDEX `idx_decision_label_due` ON `decision_outcome_labels` (`window`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_decision_label_expiry` ON `decision_outcome_labels` (`expires_at`);