-- tedix: destructive-reviewed Work-Item: 6c03071f-213c-43db-a502-33152d3c1a45
-- Remove a derived projection with no feed/library consumer. The main D1
-- audit reported zero rows; source event summaries retain workItemIds.
-- Ship must deploy the writer removal before applying this migration and
-- capture its normal recovery bookmark. No authoritative source data is
-- dropped; rollback restores the table from that bookmark if needed.
DROP INDEX IF EXISTS `workspace_work_links_work_item_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_work_links_output_idx`;--> statement-breakpoint
DROP TABLE `workspace_work_links`;
