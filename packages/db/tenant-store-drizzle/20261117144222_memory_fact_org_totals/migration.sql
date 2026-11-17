CREATE TABLE `memory_fact_org_counts` (
	`organization_id` text PRIMARY KEY,
	`total` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO memory_fact_org_counts (organization_id, total)
SELECT organization_id, count(*) FROM memory_facts GROUP BY organization_id;
--> statement-breakpoint
CREATE TRIGGER memory_fact_org_counts_insert AFTER INSERT ON memory_facts
BEGIN
  INSERT INTO memory_fact_org_counts (organization_id, total) VALUES (NEW.organization_id, 1)
  ON CONFLICT(organization_id) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_org_counts_delete AFTER DELETE ON memory_facts
BEGIN
  UPDATE memory_fact_org_counts SET total = total - 1 WHERE organization_id = OLD.organization_id;
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_org_counts_move AFTER UPDATE OF organization_id ON memory_facts
WHEN OLD.organization_id != NEW.organization_id
BEGIN
  UPDATE memory_fact_org_counts SET total = total - 1 WHERE organization_id = OLD.organization_id;
  INSERT INTO memory_fact_org_counts (organization_id, total) VALUES (NEW.organization_id, 1)
  ON CONFLICT(organization_id) DO UPDATE SET total = total + 1;
END;
