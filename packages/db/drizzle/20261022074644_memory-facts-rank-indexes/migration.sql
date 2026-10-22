CREATE INDEX `idx_memory_facts_org_type_rank` ON `memory_facts` (`organization_id`,`fact_type`,`archived_at`,`valid_to`,`confidence`,`last_accessed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_live_rank` ON `memory_facts` (`organization_id`,`archived_at`,`valid_to`,`confidence`,`last_accessed_at`,`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_archived`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_valid_to`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_org_type`;