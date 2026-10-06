CREATE TABLE `jev_review_result_receipts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`reviewer_tedi_id` text NOT NULL,
	`executor_principal_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`reviewer_run_id` text NOT NULL,
	`reviewer_session_entry_id` text NOT NULL,
	`packet_read_receipt_id` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`output_artifact_id` text NOT NULL,
	`output_sha256` text NOT NULL,
	`output_byte_length` integer NOT NULL,
	`label_sha256` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`model_family` text NOT NULL,
	`case_id` text NOT NULL,
	`packet_captured_at` text NOT NULL,
	`packet_read_at` text NOT NULL,
	`source_runs_json` text NOT NULL,
	`source_runs_sha256` text NOT NULL,
	`reviewer_completed_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_jev_review_result_receipts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_jev_review_result_packet_sha256" CHECK(length("packet_sha256") = 64 AND "packet_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_review_result_output_sha256" CHECK(length("output_sha256") = 64 AND "output_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_review_result_label_sha256" CHECK(length("label_sha256") = 64 AND "label_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_review_result_sources_sha256" CHECK(length("source_runs_sha256") = 64 AND "source_runs_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_review_result_output_bytes" CHECK("output_byte_length" > 0 AND "output_byte_length" <= 160000),
	CONSTRAINT "chk_jev_review_result_chronology" CHECK("packet_captured_at" <= "packet_read_at" AND "packet_read_at" <= "reviewer_completed_at" AND "reviewer_completed_at" <= "recorded_at"),
	CONSTRAINT "chk_jev_review_result_independent" CHECK("reviewer_tedi_id" <> "executor_principal_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_review_result_read` ON `jev_review_result_receipts` (`packet_read_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_review_result_attempt` ON `jev_review_result_receipts` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_jev_review_result_org_case` ON `jev_review_result_receipts` (`organization_id`,`case_id`);