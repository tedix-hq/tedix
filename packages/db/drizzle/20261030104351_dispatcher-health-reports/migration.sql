CREATE TABLE `dispatcher_health_reports` (
	`org_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`executor` text NOT NULL,
	`lane` text NOT NULL,
	`running` integer NOT NULL,
	`observed_at` text NOT NULL,
	`reported_at` text NOT NULL,
	`last_admission_at` text,
	`slots_in_use` integer NOT NULL,
	`slots_total` integer NOT NULL,
	`top_reason` text,
	`top_reason_count` integer,
	CONSTRAINT `dispatcher_health_reports_pk` PRIMARY KEY(`org_id`, `reporter_id`, `executor`, `lane`),
	CONSTRAINT `fk_dispatcher_health_reports_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_dispatcher_health_strings" CHECK(length("reporter_id") BETWEEN 1 AND 128
				AND length("executor") BETWEEN 1 AND 64
				AND length("lane") BETWEEN 1 AND 128
				AND ("top_reason" IS NULL OR length("top_reason") BETWEEN 1 AND 500)),
	CONSTRAINT "chk_dispatcher_health_slots" CHECK("slots_in_use" BETWEEN 0 AND 10000
				AND "slots_total" BETWEEN 0 AND 10000
				AND "slots_in_use" <= "slots_total"),
	CONSTRAINT "chk_dispatcher_health_reason" CHECK(("top_reason" IS NULL AND "top_reason_count" IS NULL)
				OR ("top_reason" IS NOT NULL AND "top_reason_count" BETWEEN 1 AND 1000000))
);
