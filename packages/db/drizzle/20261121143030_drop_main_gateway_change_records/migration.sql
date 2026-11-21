-- tedix: destructive-reviewed Work-Item: c5642d65-abc5-4707-9d0d-a34131e043fc
-- Every organization's change records live in its log store. Both tables were
-- emptied on 21 Nov 2026 after their rows were verified from the EU archive,
-- so nothing is lost. The retention policy row (mode off) goes with them.
DELETE FROM `d1_retention_policies` WHERE `table_name` = 'gateway_change_records';--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_record_checkpoints_no_bundle`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_record_checkpoints_org_last_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_record_checkpoints_org_first_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_org_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_org_recorded_at`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_recorded_at`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_unsealed`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gateway_change_records_sealed`;--> statement-breakpoint
DROP TABLE `gateway_change_record_checkpoints`;--> statement-breakpoint
DROP TABLE `gateway_change_records`;
