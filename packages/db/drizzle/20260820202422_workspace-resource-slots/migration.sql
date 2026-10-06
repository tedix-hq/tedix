ALTER TABLE `os_workspace_resources` ADD `slot` text;--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_resources_workspace_slot_unique` ON `os_workspace_resources` (`workspace_id`,`slot`);