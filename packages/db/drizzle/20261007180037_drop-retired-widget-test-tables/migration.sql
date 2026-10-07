-- tedix: destructive-reviewed Work-Item: d10fdc69-6eb6-467b-a8b1-a5c9148f1c45
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_app`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_app_slug`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_tool`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_status`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_workflow`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_widget_artifacts_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_widget_test_runs_app`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_widget_test_runs_app_slug`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_widget_test_runs_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_widget_test_runs_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_widget_test_runs_tool`;--> statement-breakpoint
DROP TABLE `generated_widget_artifacts`;--> statement-breakpoint
DROP TABLE `widget_test_runs`;