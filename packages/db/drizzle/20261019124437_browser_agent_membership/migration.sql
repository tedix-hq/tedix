ALTER TABLE `organization_members` ADD `kind` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_members` ADD `represented_user_id` text;