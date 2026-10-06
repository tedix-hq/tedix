UPDATE `runtime_profiles`
SET `published_at` = COALESCE(`created_at`, CURRENT_TIMESTAMP),
	`change_summary` = 'Imported at immutable revision cutover';
--> statement-breakpoint
UPDATE `policy_packs`
SET `published_at` = COALESCE(`created_at`, CURRENT_TIMESTAMP),
	`change_summary` = 'Imported at immutable revision cutover';
--> statement-breakpoint
UPDATE `workspace_template_sets`
SET `published_at` = COALESCE(`created_at`, CURRENT_TIMESTAMP),
	`change_summary` = 'Imported at immutable revision cutover';
