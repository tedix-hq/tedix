CREATE TABLE `workspace_activity` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`change_record_id` text NOT NULL,
	`title` text,
	`summary` text,
	`occurred_at` text NOT NULL,
	`applied_at` text NOT NULL,
	CONSTRAINT `fk_workspace_activity_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspace_feed_cursors` (
	`workspace_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`last_seq` integer NOT NULL,
	`applied_at` text NOT NULL,
	`last_event_at` text NOT NULL,
	CONSTRAINT `fk_workspace_feed_cursors_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspace_feed_ledger` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`change_record_id` text NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `fk_workspace_feed_ledger_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspace_output_index` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`output_id` text NOT NULL,
	`revision` integer NOT NULL,
	`revision_id` text NOT NULL,
	`is_current` integer DEFAULT 0 NOT NULL,
	`output_kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`note` text,
	`output_created_by_kind` text NOT NULL,
	`output_created_by_id` text NOT NULL,
	`output_created_at` text NOT NULL,
	`revision_created_by_kind` text NOT NULL,
	`revision_created_by_id` text NOT NULL,
	`revision_created_at` text NOT NULL,
	`skill_run_id` text,
	`skill_id` text,
	`access_envelope` text,
	`content_sha256` text,
	`content_bytes` integer,
	`body_r2_key` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_workspace_output_index_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspace_work_links` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`output_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`revision` integer NOT NULL,
	`linked_at` text NOT NULL,
	`unlinked_at` text,
	CONSTRAINT `fk_workspace_work_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workspace_activity_org_occurred_idx` ON `workspace_activity` (`organization_id`,`occurred_at`,`seq`);--> statement-breakpoint
CREATE INDEX `workspace_activity_workspace_seq_idx` ON `workspace_activity` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `workspace_activity_entity_idx` ON `workspace_activity` (`entity_id`,`revision`);--> statement-breakpoint
CREATE INDEX `workspace_feed_cursors_org_idx` ON `workspace_feed_cursors` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_feed_ledger_workspace_seq_unique` ON `workspace_feed_ledger` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `workspace_feed_ledger_org_idx` ON `workspace_feed_ledger` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_output_index_output_revision_unique` ON `workspace_output_index` (`output_id`,`revision`);--> statement-breakpoint
CREATE INDEX `workspace_output_index_org_current_idx` ON `workspace_output_index` (`organization_id`,`is_current`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workspace_output_index_workspace_idx` ON `workspace_output_index` (`workspace_id`,`output_id`);--> statement-breakpoint
CREATE INDEX `workspace_work_links_work_item_idx` ON `workspace_work_links` (`organization_id`,`work_item_id`);--> statement-breakpoint
CREATE INDEX `workspace_work_links_output_idx` ON `workspace_work_links` (`output_id`);