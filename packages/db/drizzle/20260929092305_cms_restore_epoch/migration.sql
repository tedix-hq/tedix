ALTER TABLE `cms_sites` ADD `restore_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cms_restore_fences` ADD `restore_epoch` integer;--> statement-breakpoint
ALTER TABLE `cms_restore_permits` ADD `restore_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cms_restore_permits` ADD `kind` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
UPDATE `cms_sites` SET `restore_epoch` = 1
WHERE EXISTS (
	SELECT 1 FROM `cms_restore_fences` AS `fence`
	WHERE `fence`.`site_id` = `cms_sites`.`id`
);
