CREATE TABLE `rationale_org_counts` (
	`org_id` text PRIMARY KEY,
	`total` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_rationale_org_counts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_work_items_org_project_disposition` ON `work_items` (`org_id`,`project_id`,`disposition`);
--> statement-breakpoint
INSERT INTO rationale_org_counts (org_id, total)
SELECT org_id, count(*) FROM tedi_rationale_records GROUP BY org_id;
--> statement-breakpoint
CREATE TRIGGER rationale_org_counts_insert AFTER INSERT ON tedi_rationale_records
BEGIN
  INSERT INTO rationale_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER rationale_org_counts_delete AFTER DELETE ON tedi_rationale_records
BEGIN
  UPDATE rationale_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER rationale_org_counts_move AFTER UPDATE OF org_id ON tedi_rationale_records
WHEN OLD.org_id != NEW.org_id
BEGIN
  UPDATE rationale_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
  INSERT INTO rationale_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;
