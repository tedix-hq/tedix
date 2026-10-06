DROP INDEX IF EXISTS `idx_work_items_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_tedi`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_rationale_org`;--> statement-breakpoint
CREATE INDEX `idx_work_items_org_created` ON `work_items` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_resource` ON `audit_events` (`organization_id`,`resource_type`,`resource_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_priority_rank` ON `memory_facts` (`organization_id`,`priority`,`archived_at`,`confidence`,`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_rationale_org_created` ON `tedi_rationale_records` (`org_id`,`created_at`);