-- tedix: destructive-reviewed Work-Item: 76e2a753-5324-446c-8f84-48d301ada745
-- Milestones were carried into epics by 20261115203018. The remaining
-- ledgers have no runtime consumers. Release through private ops with a
-- recovery point before applying this irreversible cleanup.
-- Drop triggers first, including those attached to tables that remain.
-- Keep parent unique indexes until child tables are dropped; DROP TABLE
-- removes the retired indexes without breaking composite foreign keys.
DROP TRIGGER IF EXISTS `work_item_comment_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_evidence_review_request_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_reviewer_assignment_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_assignment_insert_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_assignment_update_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_owner_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_update_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_item_open_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_item_terminal_delete_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_dependency_cycle_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_milestone_dependency_terminal_delete_guard`;--> statement-breakpoint
DROP TABLE `work_item_commit_certifications`;--> statement-breakpoint
DROP TABLE `work_item_inbox_deliveries`;--> statement-breakpoint
DROP TABLE `work_item_outbox_events`;--> statement-breakpoint
DROP TABLE `work_milestone_dependencies`;--> statement-breakpoint
DROP TABLE `work_milestone_items`;--> statement-breakpoint
DROP TABLE `work_milestones`;--> statement-breakpoint
DROP TABLE `work_sprint_items`;--> statement-breakpoint
DROP TABLE `work_sprints`;--> statement-breakpoint
DROP TABLE `release_locks`;
