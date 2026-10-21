CREATE TABLE `decision_edges` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`kind` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`evidence_ref` text,
	`note` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_decision_edges_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_decision_edges_org_from_kind_to` ON `decision_edges` (`org_id`,`from_id`,`from_kind`,`kind`,`to_id`,`to_kind`);--> statement-breakpoint
CREATE INDEX `idx_decision_edges_org_to_kind` ON `decision_edges` (`org_id`,`to_id`,`kind`);