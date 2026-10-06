CREATE TABLE `work_item_commit_certifications` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`work_item_id` text NOT NULL,
	`agent_session` text,
	`operator_override_comment_id` text,
	`mode` text NOT NULL,
	`certified_at` text NOT NULL,
	CONSTRAINT `fk_work_item_commit_certifications_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_commit_certification_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_item_commit_certification_sha" CHECK(length("commit_sha") = 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_commit_certification_sha` ON `work_item_commit_certifications` (`org_id`,`commit_sha`,`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_commit_certifications_item` ON `work_item_commit_certifications` (`work_item_id`);