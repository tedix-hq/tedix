-- tedix: destructive-reviewed Work-Item: df42071f-11a2-407b-b780-dbd5a067b4b1
-- Preservation: tedi_tasks.budget_used held only self-reported numbers that no
-- code read or enforced; spend is metered by the organization wallet and limited
-- by credit budgets. It is dropped deliberately, with no copy. Rollback: re-add
-- the column (empty) or restore from the D1 Time Travel bookmark Ship takes
-- before applying migrations.
ALTER TABLE `tedi_tasks` DROP COLUMN `budget_used`;--> statement-breakpoint
-- Money limits are objective credit budgets now; nothing ever enforced this key.
UPDATE `tedi_objectives` SET `budget_config` = json_remove(`budget_config`, '$.maxCostCents') WHERE json_valid(`budget_config`) AND json_type(`budget_config`, '$.maxCostCents') IS NOT NULL;
