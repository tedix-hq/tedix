CREATE TABLE `audit_metadata_refs` (
	`organization_id` text NOT NULL,
	`ref` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `audit_metadata_refs_pk` PRIMARY KEY(`organization_id`, `ref`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_metadata_refs_org_kind_value_idx` ON `audit_metadata_refs` (`organization_id`,`kind`,`value`);