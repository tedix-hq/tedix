-- tedix: destructive-reviewed Work-Item: de441934-7d03-48a1-8aca-e9465131d4fb
-- Owner approved deletion of these obsolete rows on 20 Nov 2026; no rows are retained.
-- The 26 Nov revision retains tedi_tasks for the historical Work foreign key.
DROP INDEX IF EXISTS `idx_work_item_projections_org_provider`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_work_item_projection_provider`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_work_case_dependency`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_case_dependency_to`;--> statement-breakpoint
DROP TABLE `work_item_projections`;--> statement-breakpoint
DROP TABLE `work_approval_executions`;--> statement-breakpoint
DROP TABLE `work_case_dependencies`;
