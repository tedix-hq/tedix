CREATE TABLE `billing_historical_decisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`decision_id` text,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`payload` text NOT NULL,
	`recorded_by` text NOT NULL,
	`recorded_user_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "historical_decision_kind" CHECK("revision">0 AND (("kind"='decision' AND "decision_id" IS NULL) OR ("kind"='revocation' AND "decision_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE `billing_historical_exposures` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`object_id` text NOT NULL,
	`object_name` text NOT NULL,
	`generation` integer NOT NULL,
	`snapshot_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`exposure` text NOT NULL,
	`payload` text NOT NULL,
	`observed_by` text NOT NULL,
	`observed_user_id` text NOT NULL,
	`observed_at` text NOT NULL,
	CONSTRAINT "historical_exposure_unknown" CHECK("exposure" = 'UNKNOWN' AND "generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_historical_decision_revision` ON `billing_historical_decisions` (`organization_id`,`tedi_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_historical_decision_operation` ON `billing_historical_decisions` (`organization_id`,`tedi_id`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_historical_exposure_operation` ON `billing_historical_exposures` (`organization_id`,`tedi_id`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_historical_exposure_source` ON `billing_historical_exposures` (`organization_id`,`tedi_id`,`object_id`,`generation`,`snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_historical_exposure_root` ON `billing_historical_exposures` (`organization_id`,`tedi_id`);