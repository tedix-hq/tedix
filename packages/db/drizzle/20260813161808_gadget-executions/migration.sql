CREATE TABLE `os_gadget_executions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`revision_id` text,
	`revision` integer,
	`status` text NOT NULL,
	`granted_capabilities` text NOT NULL,
	`policy_decision` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`costs` text,
	`evidence_refs` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_os_gadget_executions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `os_gadget_executions_org_idx` ON `os_gadget_executions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `os_gadget_executions_gadget_idx` ON `os_gadget_executions` (`gadget_id`,`created_at`);