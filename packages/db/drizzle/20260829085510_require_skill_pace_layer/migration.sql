ALTER TABLE `skill_entries` ADD COLUMN `required_pace_layer` text DEFAULT 'innovation' NOT NULL;--> statement-breakpoint
UPDATE `skill_entries`
SET `required_pace_layer` = coalesce(
	`pace_layer`,
	case coalesce(`lifecycle_state`, 'draft')
		when 'crystallized' then 'record'
		when 'proven' then 'differentiation'
		when 'active' then 'differentiation'
		else 'innovation'
	end
);--> statement-breakpoint
DROP INDEX `idx_skill_entries_pace_layer`;--> statement-breakpoint
ALTER TABLE `skill_entries` DROP COLUMN `pace_layer`;--> statement-breakpoint
ALTER TABLE `skill_entries` RENAME COLUMN `required_pace_layer` TO `pace_layer`;--> statement-breakpoint
CREATE INDEX `idx_skill_entries_pace_layer` ON `skill_entries` (`pace_layer`);
