CREATE INDEX `idx_memory_facts_org_domain_live` ON `memory_facts` (`organization_id`,`domain_id`,`archived_at`,`valid_to`,`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_memory_facts_org_domain`;
