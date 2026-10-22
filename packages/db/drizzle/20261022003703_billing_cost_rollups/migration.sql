CREATE TABLE `billing_cost_rollups` (
	`id` integer PRIMARY KEY,
	`organization_id` text NOT NULL,
	`day` text NOT NULL,
	`tedi_id` text,
	`session_type` text NOT NULL,
	`source` text NOT NULL,
	`model` text NOT NULL,
	`provider` text,
	`provider_resource` text,
	`provider_base_url` text,
	`deployment` text,
	`cost_basis` text NOT NULL,
	`success` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`estimated_cost_usd` real NOT NULL,
	`call_count` integer NOT NULL,
	`priced_call_count` integer NOT NULL,
	`unpriced_tokens` integer NOT NULL,
	`reviewed_call_count` integer NOT NULL,
	`reviewed_tokens` integer NOT NULL,
	`reviewed_cost_micros` integer NOT NULL,
	`retired_call_count` integer NOT NULL,
	`latest_snapshot_at` text NOT NULL,
	`latest_call_id` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`computed_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_cost_rollups_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_cost_rollups_grain` ON `billing_cost_rollups` (`organization_id`,`day`,`tedi_id`,`session_type`,`source`,`model`,`provider`,`provider_resource`,`provider_base_url`,`deployment`,`cost_basis`,`success`);
--> statement-breakpoint
-- Rollups are a rebuildable projection of the effective call-cost relation. Any
-- change to a raw call or its provider cost evidence marks that organization-day
-- stale; readers use raw rows for it until the daily job rebuilds the day.
CREATE TRIGGER billing_cost_rollups_stale_call_insert AFTER INSERT ON tedi_call_costs
WHEN NEW.org_id IS NOT NULL
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = NEW.org_id AND day = substr(NEW.snapshot_at, 1, 10) AND stale = 0;
END;
--> statement-breakpoint
CREATE TRIGGER billing_cost_rollups_stale_call_update AFTER UPDATE ON tedi_call_costs
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = OLD.org_id AND day = substr(OLD.snapshot_at, 1, 10) AND stale = 0;
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = NEW.org_id AND day = substr(NEW.snapshot_at, 1, 10) AND stale = 0;
END;
--> statement-breakpoint
CREATE TRIGGER billing_cost_rollups_stale_call_delete AFTER DELETE ON tedi_call_costs
WHEN OLD.org_id IS NOT NULL
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = OLD.org_id AND day = substr(OLD.snapshot_at, 1, 10) AND stale = 0;
END;
--> statement-breakpoint
CREATE TRIGGER billing_cost_rollups_stale_cost_evidence AFTER INSERT ON billing_provider_cost_evidence_versions
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = NEW.original_org_id
 AND day = substr(json_extract(NEW.original_source_snapshot, '$.snapshotAt'), 1, 10) AND stale = 0;
END;