ALTER TABLE `os_blueprints` ADD `lineage` text;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `previous_blueprint_revision_id` text;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `previous_blueprint_revision_number` integer;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `previous_instantiation_preflight` text;--> statement-breakpoint
ALTER TABLE `os_workspaces` ADD `blueprint_decision` text;