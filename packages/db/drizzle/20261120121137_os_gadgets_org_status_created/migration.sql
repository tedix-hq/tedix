CREATE INDEX `os_gadgets_org_status_created_idx` ON `os_gadgets` (`organization_id`,`status`,`created_at`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `os_gadgets_org_idx`;
