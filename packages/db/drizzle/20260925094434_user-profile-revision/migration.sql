ALTER TABLE `users` ADD `profile_revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `sync_user_profile_to_memberships`
AFTER UPDATE OF `name`, `avatar_url` ON `users`
FOR EACH ROW
BEGIN
	UPDATE `organization_members`
	SET
		`name` = NEW.`name`,
		`avatar_url` = NEW.`avatar_url`,
		`updated_at` = NEW.`updated_at`
	WHERE `user_id` = NEW.`id`;
END;
