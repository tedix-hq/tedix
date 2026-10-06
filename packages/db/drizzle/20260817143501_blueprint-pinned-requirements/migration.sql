ALTER TABLE `os_gadgets` ADD `source_blueprint_revision_id` text;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `source_blueprint_revision_number` integer;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `instantiation_preflight` text;