CREATE INDEX `os_gadget_executions_org_workspace_environment_idx` ON `os_gadget_executions` (`organization_id`,`workspace_id`,`runtime_environment`);--> statement-breakpoint
CREATE INDEX `os_workspace_projects_org_project_status_idx` ON `os_workspace_projects` (`organization_id`,`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_projects_status_id` ON `projects` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_projects_org_status_id` ON `projects` (`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_projects_org_objective_status` ON `projects` (`org_id`,`objective_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_work_items_org_objective` ON `work_items` (`org_id`,`objective_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_org_work_environment` ON `skill_runs` (`organization_id`,`work_item_id`,`runtime_environment`);--> statement-breakpoint
CREATE INDEX `idx_objectives_status_id` ON `tedi_objectives` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_objectives_org_status_id` ON `tedi_objectives` (`org_id`,`status`,`id`);