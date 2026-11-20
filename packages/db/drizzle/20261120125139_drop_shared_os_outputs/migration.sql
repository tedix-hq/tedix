-- tedix: destructive-reviewed Work-Item: 13532366-7d04-4265-ad15-604ce4736319
-- Scope: workspace files and revisions live only in each workspace's own store
-- since the 13-18 Nov 2026 switch; nothing in the product reads or writes these
-- shared copies (checked in this repository and the ops repository).
-- Preservation: every row was copied into its workspace store and reconciled
-- before the switch; D1 Time Travel keeps the pre-drop state for its window.
-- Rollback: restore the database to a bookmark before this migration.
DROP INDEX IF EXISTS `os_output_revisions_output_revision_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_revisions_org_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_revisions_skill_run_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_outputs_org_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_outputs_workspace_idx`;--> statement-breakpoint
DROP TABLE `os_output_revisions`;--> statement-breakpoint
DROP TABLE `os_outputs`;