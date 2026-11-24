ALTER TABLE `os_gadgets` ADD `has_work_navigation` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `os_gadgets` SET `has_work_navigation` = EXISTS (
	SELECT 1 FROM `os_gadget_revisions` AS r
	WHERE r.id = os_gadgets.current_revision_id
		AND r.organization_id = os_gadgets.organization_id
		AND +r.gadget_id = os_gadgets.id
		AND (json_extract(r.manifest, '$.navigation.work') IN ('deck', 'feed')
			OR json_extract(r.manifest, '$.navigation.board') = 1)
);--> statement-breakpoint
CREATE INDEX `os_gadgets_org_work_status_created_idx` ON `os_gadgets` (`organization_id`,`has_work_navigation`,`status`,`created_at`,`id`);
