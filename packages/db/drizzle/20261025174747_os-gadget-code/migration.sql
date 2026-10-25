CREATE TABLE `os_gadget_code` (
	`revision_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`files` text NOT NULL,
	`code_length` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_gadget_code_revision_id_os_gadget_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `os_gadget_revisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadget_code_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadget_code_gadget_id_os_gadgets_id_fk` FOREIGN KEY (`gadget_id`) REFERENCES `os_gadgets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `os_gadget_code_gadget_idx` ON `os_gadget_code` (`gadget_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_gadget_code_org_idx` ON `os_gadget_code` (`organization_id`);