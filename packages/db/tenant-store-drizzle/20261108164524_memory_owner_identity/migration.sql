CREATE TABLE `memory_store_identity` (
	`slot` integer PRIMARY KEY,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "memory_store_identity_single_row" CHECK("slot" = 1),
	CONSTRAINT "memory_store_identity_kind" CHECK("kind" IN ('organization','workspace','personal')),
	CONSTRAINT "memory_store_identity_owner" CHECK(length(trim("owner_id")) > 0 AND ("kind" != 'organization' OR "owner_id" = "organization_id"))
);
--> statement-breakpoint
CREATE VIEW memory_store_organizations AS
SELECT slot, organization_id FROM tenant_store_identity
UNION ALL
SELECT slot, organization_id FROM memory_store_identity;
--> statement-breakpoint
DROP TRIGGER tenant_memory_domains_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_domains_insert_scope BEFORE INSERT ON memory_domains
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_domains_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_domains_update_scope BEFORE UPDATE ON memory_domains
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_facts_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_facts_insert_scope BEFORE INSERT ON memory_facts
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_facts_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_facts_update_scope BEFORE UPDATE ON memory_facts
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entities_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entities_insert_scope BEFORE INSERT ON memory_entities
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entities_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entities_update_scope BEFORE UPDATE ON memory_entities
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_mentions_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_mentions_insert_scope BEFORE INSERT ON memory_entity_mentions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_mentions_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_mentions_update_scope BEFORE UPDATE ON memory_entity_mentions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_aliases_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_aliases_insert_scope BEFORE INSERT ON memory_entity_aliases
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_aliases_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_aliases_update_scope BEFORE UPDATE ON memory_entity_aliases
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolution_heads_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_heads_insert_scope BEFORE INSERT ON memory_entity_resolution_heads
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolution_heads_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_heads_update_scope BEFORE UPDATE ON memory_entity_resolution_heads
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolution_decisions_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_decisions_insert_scope BEFORE INSERT ON memory_entity_resolution_decisions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolution_decisions_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_decisions_update_scope BEFORE UPDATE ON memory_entity_resolution_decisions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolutions_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolutions_insert_scope BEFORE INSERT ON memory_entity_resolutions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_entity_resolutions_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolutions_update_scope BEFORE UPDATE ON memory_entity_resolutions
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_fact_citations_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citations_insert_scope BEFORE INSERT ON memory_fact_citations
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_fact_citations_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citations_update_scope BEFORE UPDATE ON memory_fact_citations
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_fact_citation_backfills_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citation_backfills_insert_scope BEFORE INSERT ON memory_fact_citation_backfills
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_memory_fact_citation_backfills_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citation_backfills_update_scope BEFORE UPDATE ON memory_fact_citation_backfills
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_graph_projection_outbox_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_graph_projection_outbox_insert_scope BEFORE INSERT ON graph_projection_outbox
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_graph_projection_outbox_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_graph_projection_outbox_update_scope BEFORE UPDATE ON graph_projection_outbox
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER `tenant_tedi_expertise_domain_insert_scope`;
--> statement-breakpoint
CREATE TRIGGER `tenant_tedi_expertise_domain_insert_scope`
BEFORE INSERT ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_domains` d
	JOIN `memory_store_organizations` identity
	  ON identity.`organization_id` = d.`organization_id` AND identity.`slot` = 1
	WHERE d.`id` = NEW.`domain_id`
)
BEGIN
	SELECT RAISE(ABORT, 'expertise domain is outside this workspace');
END;
--> statement-breakpoint
DROP TRIGGER `tenant_tedi_expertise_domain_update_scope`;
--> statement-breakpoint
CREATE TRIGGER `tenant_tedi_expertise_domain_update_scope`
BEFORE UPDATE OF `tedi_id`, `domain_id` ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_domains` d
	JOIN `memory_store_organizations` identity
	  ON identity.`organization_id` = d.`organization_id` AND identity.`slot` = 1
	WHERE d.`id` = NEW.`domain_id`
)
BEGIN
	SELECT RAISE(ABORT, 'expertise domain is outside this workspace');
END;
--> statement-breakpoint
DROP TRIGGER tenant_tedi_curiosity_queue_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_curiosity_queue_insert_scope BEFORE INSERT ON tedi_curiosity_queue
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_tedi_curiosity_queue_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_curiosity_queue_update_scope BEFORE UPDATE ON tedi_curiosity_queue
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_tedi_optimization_signals_insert_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_optimization_signals_insert_scope BEFORE INSERT ON tedi_optimization_signals
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
DROP TRIGGER tenant_tedi_optimization_signals_update_scope;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_optimization_signals_update_scope BEFORE UPDATE ON tedi_optimization_signals
WHEN NOT EXISTS (SELECT 1 FROM memory_store_organizations WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER memory_store_identity_no_workspace BEFORE INSERT ON memory_store_identity
WHEN EXISTS (SELECT 1 FROM tenant_store_identity)
BEGIN SELECT RAISE(ABORT, 'Workspace memory cannot be silently reclassified'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_store_identity_no_memory_owner BEFORE INSERT ON tenant_store_identity
WHEN EXISTS (SELECT 1 FROM memory_store_identity)
BEGIN SELECT RAISE(ABORT, 'Memory-only objects cannot become workspaces'); END;
--> statement-breakpoint
CREATE TRIGGER memory_store_identity_no_update BEFORE UPDATE ON memory_store_identity
BEGIN SELECT RAISE(ABORT, 'Memory ownership is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER memory_store_identity_no_delete BEFORE DELETE ON memory_store_identity
BEGIN SELECT RAISE(ABORT, 'Memory ownership is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER memory_store_identity_no_replace BEFORE INSERT ON memory_store_identity
WHEN EXISTS (SELECT 1 FROM memory_store_identity)
BEGIN SELECT RAISE(ABORT, 'Memory ownership is immutable'); END;
