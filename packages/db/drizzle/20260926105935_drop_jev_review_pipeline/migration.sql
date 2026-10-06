DROP INDEX IF EXISTS `uniq_jev_extraction_claim_source`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_extraction_claim_work`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_extraction_source_capture`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_extraction_source_job`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_review_packet_read_attempt`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_review_packet_read_nonce`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_jev_review_packet_read_artifact`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_review_result_read`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_jev_review_result_attempt`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_jev_review_result_org_case`;--> statement-breakpoint
DROP TABLE `jev_extraction_claim_attestations`;--> statement-breakpoint
DROP TABLE `jev_extraction_source_captures`;--> statement-breakpoint
DROP TABLE `jev_review_packet_reads`;--> statement-breakpoint
DROP TABLE `jev_review_result_receipts`;