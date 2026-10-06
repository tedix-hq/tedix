ALTER TABLE `skill_schedules` ADD `last_budget_blocked_at` text;--> statement-breakpoint
ALTER TABLE `skill_schedules` ADD `last_budget_blocked_reason` text;--> statement-breakpoint
ALTER TABLE `skill_schedules` ADD `last_budget_reset_at` text;--> statement-breakpoint
ALTER TABLE `skill_schedules` ADD `last_budget_admission_class` text;--> statement-breakpoint
UPDATE `skill_schedules`
SET
	`last_budget_blocked_at` = `last_fire_at`,
	`last_budget_blocked_reason` = `last_error`,
	`last_budget_reset_at` = strftime('%Y-%m-%dT%H:%M:%fZ', date(`last_fire_at`, '+1 day')),
	`last_budget_admission_class` = 'background',
	`last_error` = NULL
WHERE `last_error` = 'suppressed: tedi background inference budget exhausted for the day';
