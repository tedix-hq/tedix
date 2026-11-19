CREATE TABLE `gateway_change_record_checkpoints` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`record_count` integer NOT NULL,
	`head_chain_hash` text NOT NULL,
	`previous_checkpoint_digest` text,
	`previous_chain_hash` text,
	`checkpoint_digest` text NOT NULL,
	`sealed_at` text NOT NULL,
	`envelope` text,
	`key_id` text
);
--> statement-breakpoint
ALTER TABLE `gateway_change_records` ADD `record_digest` text;--> statement-breakpoint
ALTER TABLE `gateway_change_records` ADD `chain_hash` text;--> statement-breakpoint
CREATE INDEX `idx_gateway_change_record_checkpoints_org_last_sequence` ON `gateway_change_record_checkpoints` (`organization_id`,`last_sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gateway_change_record_checkpoints_org_first_sequence` ON `gateway_change_record_checkpoints` (`organization_id`,`first_sequence`);--> statement-breakpoint
CREATE INDEX `idx_gateway_change_records_unsealed` ON `gateway_change_records` (`organization_id`,`sequence`) WHERE chain_hash is null;