CREATE TABLE `jev_extraction_claim_attestations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`source_receipt_id` text NOT NULL,
	`capture_id` text NOT NULL,
	`job_id` text NOT NULL,
	`docs_build_id` text NOT NULL,
	`items_sha256` text NOT NULL,
	`docs_sources_sha256` text NOT NULL,
	`docs_total_byte_length` integer NOT NULL,
	`source_captured_at` text NOT NULL,
	`docs_fetched_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_jev_extraction_claim_attestations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_jev_extraction_claim_digests" CHECK(length("items_sha256") = 64 AND "items_sha256" NOT GLOB '*[^0-9a-f]*' AND length("docs_sources_sha256") = 64 AND "docs_sources_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chk_jev_extraction_claim_bytes" CHECK("docs_total_byte_length" > 0 AND "docs_total_byte_length" <= 500000),
	CONSTRAINT "chk_jev_extraction_claim_chronology" CHECK("source_captured_at" <= "docs_fetched_at" AND "docs_fetched_at" <= "recorded_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_extraction_claim_source` ON `jev_extraction_claim_attestations` (`organization_id`,`source_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jev_extraction_claim_work` ON `jev_extraction_claim_attestations` (`organization_id`,`work_item_id`);