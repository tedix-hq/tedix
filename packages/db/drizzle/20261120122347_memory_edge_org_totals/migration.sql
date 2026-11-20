CREATE TABLE `memory_edge_org_counts` (
	`organization_id` text PRIMARY KEY,
	`total` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_memory_edge_org_counts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO memory_edge_org_counts (organization_id, total)
SELECT source.organization_id, count(*) FROM memory_edges edge
JOIN memory_facts source ON source.id = edge.source_fact_id
JOIN memory_facts target ON target.id = edge.target_fact_id
WHERE target.organization_id = source.organization_id
GROUP BY source.organization_id;
--> statement-breakpoint
CREATE TRIGGER memory_edge_org_counts_insert AFTER INSERT ON memory_edges
BEGIN
  INSERT INTO memory_edge_org_counts (organization_id, total)
  SELECT source.organization_id, 1 FROM memory_facts source, memory_facts target
    WHERE source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id AND target.organization_id = source.organization_id
  ON CONFLICT(organization_id) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER memory_edge_org_counts_delete AFTER DELETE ON memory_edges
BEGIN
  UPDATE memory_edge_org_counts SET total = total - 1
  WHERE organization_id = (SELECT source.organization_id FROM memory_facts source, memory_facts target
    WHERE source.id = OLD.source_fact_id AND target.id = OLD.target_fact_id AND target.organization_id = source.organization_id);
END;
--> statement-breakpoint
CREATE TRIGGER memory_edge_org_counts_repoint AFTER UPDATE OF source_fact_id, target_fact_id ON memory_edges
WHEN OLD.source_fact_id != NEW.source_fact_id OR OLD.target_fact_id != NEW.target_fact_id
BEGIN
  UPDATE memory_edge_org_counts SET total = total - 1
  WHERE organization_id = (SELECT source.organization_id FROM memory_facts source, memory_facts target
    WHERE source.id = OLD.source_fact_id AND target.id = OLD.target_fact_id AND target.organization_id = source.organization_id);
  INSERT INTO memory_edge_org_counts (organization_id, total)
  SELECT source.organization_id, 1 FROM memory_facts source, memory_facts target
    WHERE source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id AND target.organization_id = source.organization_id
  ON CONFLICT(organization_id) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER memory_edge_org_counts_fact_delete BEFORE DELETE ON memory_facts
BEGIN
  UPDATE memory_edge_org_counts SET total = total - ((SELECT count(*) FROM memory_edges edge, memory_facts other
    WHERE edge.source_fact_id = OLD.id AND other.id = edge.target_fact_id AND other.organization_id = OLD.organization_id)
  + (SELECT count(*) FROM memory_edges edge, memory_facts other
    WHERE edge.target_fact_id = OLD.id AND edge.source_fact_id != OLD.id
    AND other.id = edge.source_fact_id AND other.organization_id = OLD.organization_id))
  WHERE organization_id = OLD.organization_id;
END;
