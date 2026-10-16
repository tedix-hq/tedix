ALTER TABLE `os_workspaces` ADD `visibility` text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `owner_user_id` text;