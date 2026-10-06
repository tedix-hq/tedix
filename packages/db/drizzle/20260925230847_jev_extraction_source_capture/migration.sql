CREATE TABLE `jev_extraction_source_captures` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`app_id` text NOT NULL,
	`capture_id` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`job_id` text NOT NULL,
	`config_key` text NOT NULL,
	`webhook_key` text NOT NULL,
	`packet_key` text NOT NULL,
	`config_sha256` text NOT NULL,
	`webhook_sha256` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`config_byte_length` integer NOT NULL,
	`webhook_byte_length` integer NOT NULL,
	`packet_byte_length` integer NOT NULL,
	`config_captured_at` text NOT NULL,
	`webhook_captured_at` text NOT NULL,
	`packet_captured_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_jev_extraction_source_captures_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_jev_extraction_source_digests" CHECK(length("config_sha256") = 64 AND "config_sha256" NOT GLOB '*[^0-9a-f]*' AND length("webhook_sha256") = 64 AND "webhook_sha256" NOT GLOB '*[^0-9a-f]*' AND length("packet_sha256") = 64 AND "packet_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_extraction_source_sizes" CHECK("config_byte_length" > 0 AND "config_byte_length" <= 131072 AND "webhook_byte_length" > 0 AND "webhook_byte_length" <= 2097152 AND "packet_byte_length" > 0 AND "packet_byte_length" <= 2232320),
	CONSTRAINT "chk_jev_extraction_source_chronology" CHECK("config_captured_at" <= "webhook_captured_at" AND "webhook_captured_at" <= "packet_captured_at" AND "packet_captured_at" <= "recorded_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_extraction_source_capture` ON `jev_extraction_source_captures` (`organization_id`,`capture_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_extraction_source_job` ON `jev_extraction_source_captures` (`organization_id`,`job_id`);