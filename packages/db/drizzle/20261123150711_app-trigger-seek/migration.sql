ALTER TABLE `os_gadgets` ADD `has_runtime_triggers` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `os_gadgets` SET `has_runtime_triggers` = EXISTS (
	SELECT 1 FROM `os_gadget_revisions` AS r
	WHERE r.id = os_gadgets.current_revision_id
		AND r.organization_id = os_gadgets.organization_id
		AND r.gadget_id = os_gadgets.id
		AND json_extract(r.manifest, '$.entry') = 'tedix:runtime/v1'
		AND json_type(r.manifest, '$.config.triggers') = 'array'
);--> statement-breakpoint
CREATE INDEX `os_gadgets_triggers_status_created_idx` ON `os_gadgets` (`has_runtime_triggers`,`status`,`created_at`,`id`);
