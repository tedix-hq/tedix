CREATE TABLE `work_item_org_counts` (
	`org_id` text PRIMARY KEY,
	`total` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_work_item_org_counts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_fact_org_counts` (
	`organization_id` text PRIMARY KEY,
	`total` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_memory_fact_org_counts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO work_item_org_counts (org_id, total)
SELECT org_id, count(*) FROM work_items GROUP BY org_id;
--> statement-breakpoint
CREATE TRIGGER work_item_org_counts_insert AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER work_item_org_counts_delete AFTER DELETE ON work_items
BEGIN
  UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER work_item_org_counts_move AFTER UPDATE OF org_id ON work_items
WHEN OLD.org_id != NEW.org_id
BEGIN
  UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
  INSERT INTO work_item_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;
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
