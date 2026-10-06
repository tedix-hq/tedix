CREATE TABLE `jev_review_packet_reads` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`reviewer_tedi_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`home_run_id` text NOT NULL,
	`reviewer_run_id` text NOT NULL,
	`attestation_nonce` text NOT NULL,
	`packet_artifact_id` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`packet_byte_length` integer NOT NULL,
	`packet_kind` text NOT NULL,
	`case_id` text NOT NULL,
	`read_at` text NOT NULL,
	CONSTRAINT `fk_jev_review_packet_reads_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_jev_review_packet_sha256" CHECK(length("packet_sha256") = 64 AND "packet_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_review_packet_bytes" CHECK("packet_byte_length" > 0 AND "packet_byte_length" <= 160000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_review_packet_read_attempt` ON `jev_review_packet_reads` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_review_packet_read_nonce` ON `jev_review_packet_reads` (`attestation_nonce`);--> statement-breakpoint
CREATE INDEX `idx_jev_review_packet_read_artifact` ON `jev_review_packet_reads` (`organization_id`,`packet_artifact_id`);