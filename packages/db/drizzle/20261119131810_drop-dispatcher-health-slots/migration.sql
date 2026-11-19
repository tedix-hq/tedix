-- tedix: destructive-reviewed Work-Item: c0691bbc-fdff-449f-a18b-1c1e3fe3b3a9
-- Drops the fixed dispatcher slot counts (slots_in_use, slots_total): runners
-- no longer have a slot limit. The rebuild copies every other column of each
-- current health report; no table references dispatcher_health_reports.
CREATE TABLE `__new_dispatcher_health_reports` (
	`org_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`executor` text NOT NULL,
	`lane` text NOT NULL,
	`running` integer NOT NULL,
	`observed_at` text NOT NULL,
	`reported_at` text NOT NULL,
	`last_admission_at` text,
	`top_reason` text,
	`top_reason_count` integer,
	`duty` text,
	CONSTRAINT `dispatcher_health_reports_pk` PRIMARY KEY(`org_id`, `reporter_id`, `executor`, `lane`),
	CONSTRAINT `fk_dispatcher_health_reports_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_dispatcher_health_strings" CHECK(length("reporter_id") BETWEEN 1 AND 128
				AND length("executor") BETWEEN 1 AND 64
				AND length("lane") BETWEEN 1 AND 128
				AND ("top_reason" IS NULL OR length("top_reason") BETWEEN 1 AND 500)),
	CONSTRAINT "chk_dispatcher_health_reason" CHECK(("top_reason" IS NULL AND "top_reason_count" IS NULL)
				OR ("top_reason" IS NOT NULL AND "top_reason_count" BETWEEN 1 AND 1000000))
);
--> statement-breakpoint
INSERT INTO `__new_dispatcher_health_reports`(`org_id`, `reporter_id`, `executor`, `lane`, `running`, `observed_at`, `reported_at`, `last_admission_at`, `top_reason`, `top_reason_count`, `duty`) SELECT `org_id`, `reporter_id`, `executor`, `lane`, `running`, `observed_at`, `reported_at`, `last_admission_at`, `top_reason`, `top_reason_count`, `duty` FROM `dispatcher_health_reports`;--> statement-breakpoint
DROP TABLE `dispatcher_health_reports`;--> statement-breakpoint
ALTER TABLE `__new_dispatcher_health_reports` RENAME TO `dispatcher_health_reports`;