CREATE TABLE `work_interaction_card_revisions` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`request_id` text NOT NULL,
	`revision` integer NOT NULL,
	`body` text NOT NULL,
	`cause` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`instruction` text,
	`response_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_interaction_card_revisions_org_id_request_id_work_interactions_org_id_id_fk` FOREIGN KEY (`org_id`,`request_id`) REFERENCES `work_interactions`(`org_id`,`id`),
	CONSTRAINT "chk_card_revision_positive" CHECK("revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_card_revision` ON `work_interaction_card_revisions` (`org_id`,`request_id`,`revision`);
--> statement-breakpoint
CREATE TRIGGER card_revision_no_update BEFORE UPDATE ON work_interaction_card_revisions BEGIN SELECT RAISE(ABORT, 'Card revisions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER card_revision_no_delete BEFORE DELETE ON work_interaction_card_revisions BEGIN SELECT RAISE(ABORT, 'Card revisions are append-only'); END;
