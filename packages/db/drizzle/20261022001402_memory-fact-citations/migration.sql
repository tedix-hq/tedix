CREATE TABLE `memory_fact_citation_backfills` (
	`organization_id` text PRIMARY KEY,
	`source` text NOT NULL,
	`fact_id` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_memory_fact_citation_backfills_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_fact_citations` (
	`organization_id` text NOT NULL,
	`cited_fact_id` text NOT NULL,
	`consolidated_fact_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `memory_fact_citations_pk` PRIMARY KEY(`consolidated_fact_id`, `cited_fact_id`),
	CONSTRAINT `fk_memory_fact_citations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_fact_citations_consolidated_fact_id_memory_facts_id_fk` FOREIGN KEY (`consolidated_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_memory_fact_citations_org_cited` ON `memory_fact_citations` (`organization_id`,`cited_fact_id`);
--> statement-breakpoint
-- Rebuildable citation projection; deletes below remove links, never canonical facts.
-- Triggers cover persist's head/history batch, generic createFact/createFacts/updateFact,
-- and any metadata replacement without a second, non-atomic application write.
-- tedix: destructive-reviewed Work-Item: 7ecf382f-92c9-49b6-82c2-ced1aaae71d2
CREATE TRIGGER memory_fact_citations_insert AFTER INSERT ON memory_facts
WHEN json_type(NEW.metadata, '$.consolidation.evidence.sources') = 'array'
BEGIN
 INSERT OR IGNORE INTO memory_fact_citations(organization_id, cited_fact_id, consolidated_fact_id)
 SELECT NEW.organization_id, json_extract(citation.value, '$.id'), NEW.id
 FROM json_each(NEW.metadata, '$.consolidation.evidence.sources') citation
 WHERE citation.type = 'object' AND json_type(citation.value, '$.id') = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_citations_update AFTER UPDATE OF metadata, organization_id, id ON memory_facts
BEGIN
 DELETE FROM memory_fact_citations WHERE consolidated_fact_id = OLD.id;
 INSERT OR IGNORE INTO memory_fact_citations(organization_id, cited_fact_id, consolidated_fact_id)
 SELECT NEW.organization_id, json_extract(citation.value, '$.id'), NEW.id
 FROM json_each(NEW.metadata, '$.consolidation.evidence.sources') citation
 WHERE json_type(NEW.metadata, '$.consolidation.evidence.sources') = 'array'
  AND citation.type = 'object' AND json_type(citation.value, '$.id') = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_citations_delete AFTER DELETE ON memory_facts
BEGIN
 DELETE FROM memory_fact_citations WHERE consolidated_fact_id = OLD.id;
END;
