CREATE INDEX `idx_learning_event_surface_kind_occurred` ON `learning_interaction_events` (`organization_id`,`surface`,`event_kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_scope_occurred` ON `learning_interaction_events` (`organization_id`,`scope_kind`,`scope_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_event_corrections` ON `learning_interaction_events` (`organization_id`,`scope_kind`,`scope_id`,`actor_id`) WHERE event_kind = 'undone';--> statement-breakpoint
CREATE INDEX `idx_work_approval_item_created` ON `work_approval_proposals` (`org_id`,`work_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_org_updated` ON `kernel_runtime_runs` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_global_kind_created` ON `tedi_runtime_events` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_visibility_policy_updated` ON `memory_facts` (`organization_id`,`visibility`,`review_status`,`use_policy`,`updated_at`);