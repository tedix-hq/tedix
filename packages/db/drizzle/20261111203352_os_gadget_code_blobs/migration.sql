CREATE TABLE `os_gadget_code_blobs` (
	`organization_id` text NOT NULL,
	`sha256` text NOT NULL,
	`files` text NOT NULL,
	`code_length` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `os_gadget_code_blobs_pk` PRIMARY KEY(`organization_id`, `sha256`),
	CONSTRAINT `fk_os_gadget_code_blobs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_gadget_code` ADD `files_sha256` text;