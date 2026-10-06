CREATE TABLE `work_admissions` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`work_item_version` integer NOT NULL,
	`admission_spec_revision` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_session_id` text,
	`external_session_key` text,
	`decision` text NOT NULL,
	`rejection_code` text,
	`rejection_reason` text,
	`rejection_key` text,
	`max_cost_micros` integer,
	`decided_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_admissions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_admission_item` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_admission_identity" CHECK(("executor_type" = 'tedi' AND "executor_session_id" IS NULL AND "external_session_key" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL AND "external_session_key" IS NOT NULL)),
	CONSTRAINT "chk_work_admission_decision" CHECK(("decision" = 'admitted' AND "rejection_code" IS NULL AND "rejection_reason" IS NULL AND "rejection_key" IS NULL) OR ("decision" = 'rejected' AND "rejection_code" IS NOT NULL AND "rejection_reason" IS NOT NULL AND "rejection_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `work_approval_decisions` (
	`id` text PRIMARY KEY,
	`proposal_id` text NOT NULL,
	`resolved_proposal_version` integer NOT NULL,
	`decision` text NOT NULL,
	`decider_type` text NOT NULL,
	`decider_id` text NOT NULL,
	`rationale` text NOT NULL,
	`decided_at` text NOT NULL,
	CONSTRAINT `fk_work_approval_decisions_proposal_id_work_approval_proposals_id_fk` FOREIGN KEY (`proposal_id`) REFERENCES `work_approval_proposals`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `work_approval_proposals` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`work_item_version` integer NOT NULL,
	`authority_key` text NOT NULL,
	`action` text NOT NULL,
	`proposal` text NOT NULL,
	`requester_type` text NOT NULL,
	`requester_id` text NOT NULL,
	`requester_session_id` text,
	`approver_type` text NOT NULL,
	`approver_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rationale` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolution_fence` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_approval_proposals_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_approval_proposal_item` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_budget_envelopes` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`limit_micros` integer NOT NULL,
	`reservation_micros` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_budget_envelopes_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_budget_limit" CHECK("limit_micros" >= 0),
	CONSTRAINT "chk_work_budget_reservation" CHECK("reservation_micros" >= 0 AND "reservation_micros" <= "limit_micros")
);
--> statement-breakpoint
CREATE TABLE `work_budget_reservations` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`envelope_version` integer NOT NULL,
	`amount_micros` integer NOT NULL,
	`consumed_micros` integer,
	`state` text DEFAULT 'active' NOT NULL,
	`reserved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`settled_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_budget_reservation_admission` FOREIGN KEY (`org_id`,`work_item_id`,`admission_id`) REFERENCES `work_admissions`(`org_id`,`work_item_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_work_budget_reservation_envelope` FOREIGN KEY (`org_id`,`envelope_id`) REFERENCES `work_budget_envelopes`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_budget_reservation_amount" CHECK("amount_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE `work_case_dependencies` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`prerequisite_case_id` text NOT NULL,
	`dependent_case_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_case_dependencies_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_case_dependency_from` FOREIGN KEY (`org_id`,`prerequisite_case_id`) REFERENCES `work_cases`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_case_dependency_to` FOREIGN KEY (`org_id`,`dependent_case_id`) REFERENCES `work_cases`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_case_dependency_not_self" CHECK("prerequisite_case_id" <> "dependent_case_id")
);
--> statement-breakpoint
CREATE TABLE `work_case_items` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`case_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`rationale` text,
	`discovered_at` text NOT NULL,
	CONSTRAINT `fk_work_case_item_case` FOREIGN KEY (`org_id`,`case_id`) REFERENCES `work_cases`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_case_item_work` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_cases` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text,
	`objective_id` text,
	`title` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`stage` text DEFAULT 'investigating' NOT NULL,
	`accountable_owner_type` text NOT NULL,
	`accountable_owner_id` text NOT NULL,
	`opened_at` text NOT NULL,
	`target_resolution_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`closed_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_cases_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_case_project` FOREIGN KEY (`org_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_case_owner" CHECK(length("accountable_owner_id") > 0)
);
--> statement-breakpoint
CREATE TABLE `work_interaction_responses` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`resolved_request_version` integer NOT NULL,
	`resolution_fence` text NOT NULL,
	`responder_type` text NOT NULL,
	`responder_id` text NOT NULL,
	`responder_session_id` text,
	`body` text NOT NULL,
	`response_kind` text NOT NULL,
	`artifact_ref` text,
	`artifact_version` text,
	`artifact_digest` text,
	`resolves_request` integer DEFAULT false NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`responded_at` text NOT NULL,
	CONSTRAINT `fk_work_interaction_responses_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_response_request` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `work_interactions` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text,
	`case_id` text,
	`project_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`subject` text NOT NULL,
	`prompt` text NOT NULL,
	`creator_type` text NOT NULL,
	`creator_id` text NOT NULL,
	`creator_session_id` text,
	`target_type` text,
	`target_id` text,
	`due_at` text,
	`expires_at` text,
	`resolution_fence` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`cancelled_at` text,
	`expired_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_work_interactions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_item` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_case` FOREIGN KEY (`org_id`,`case_id`) REFERENCES `work_cases`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_project` FOREIGN KEY (`org_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_interaction_context" CHECK("work_item_id" IS NOT NULL OR "case_id" IS NOT NULL OR "project_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `work_milestone_dependencies` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`prerequisite_milestone_id` text NOT NULL,
	`dependent_milestone_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_milestone_dependency_from` FOREIGN KEY (`org_id`,`prerequisite_milestone_id`) REFERENCES `work_milestones`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_milestone_dependency_to` FOREIGN KEY (`org_id`,`dependent_milestone_id`) REFERENCES `work_milestones`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_milestone_dependency_not_self" CHECK("prerequisite_milestone_id" <> "dependent_milestone_id")
);
--> statement-breakpoint
CREATE TABLE `work_milestone_items` (
	`org_id` text NOT NULL,
	`milestone_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `work_milestone_items_pk` PRIMARY KEY(`org_id`, `milestone_id`, `work_item_id`),
	CONSTRAINT `fk_work_milestone_item_milestone` FOREIGN KEY (`org_id`,`milestone_id`) REFERENCES `work_milestones`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_milestone_item_work` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_milestones` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`accountable_owner_type` text NOT NULL,
	`accountable_owner_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`target_at` text,
	`proof_ref` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`done_at` text,
	`cancelled_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_milestones_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_milestone_project` FOREIGN KEY (`org_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_project_health_judgments` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`target_at` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`observed_at` text NOT NULL,
	CONSTRAINT `fk_work_project_health_judgments_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_project_health_project` FOREIGN KEY (`org_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `work_resource_pools` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`allocation_mode` text NOT NULL,
	`capacity` integer NOT NULL,
	`owner_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_resource_pools_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_resource_pool_capacity" CHECK("capacity" > 0),
	CONSTRAINT "chk_work_resource_pool_mode" CHECK("allocation_mode" <> 'exclusive' OR "capacity" = 1)
);
--> statement-breakpoint
CREATE TABLE `work_resource_requirements` (
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `work_resource_requirements_pk` PRIMARY KEY(`org_id`, `work_item_id`, `resource_key`),
	CONSTRAINT `fk_work_resource_requirement_item` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_resource_requirement_pool` FOREIGN KEY (`org_id`,`resource_key`) REFERENCES `work_resource_pools`(`org_id`,`resource_key`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_resource_requirement_quantity" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `work_resource_reservations` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`pool_version` integer NOT NULL,
	`resource_key` text NOT NULL,
	`quantity` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`reserved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`settled_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_resource_reservation_admission` FOREIGN KEY (`org_id`,`work_item_id`,`admission_id`) REFERENCES `work_admissions`(`org_id`,`work_item_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_work_resource_reservation_pool` FOREIGN KEY (`org_id`,`pool_id`) REFERENCES `work_resource_pools`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_resource_reservation_quantity" CHECK("quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE `work_attempts` ADD `admission_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `admission_spec_revision` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
UPDATE `work_items` SET `admission_spec_revision` = lower(hex(randomblob(16)));--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_projects_org_id` ON `projects` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_admission` ON `work_attempts` (`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_admission_org_item_id` ON `work_admissions` (`org_id`,`work_item_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_admission_rejection_key` ON `work_admissions` (`org_id`,`rejection_key`);--> statement-breakpoint
CREATE INDEX `idx_work_admission_executor_time` ON `work_admissions` (`org_id`,`executor_type`,`executor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_admission_item_time` ON `work_admissions` (`org_id`,`work_item_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_approval_decision_proposal` ON `work_approval_decisions` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `idx_work_approval_decisions_time` ON `work_approval_decisions` (`decided_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_approval_pending_scope` ON `work_approval_proposals` (`org_id`,`work_item_id`,`work_item_version`,`authority_key`,`action`,`approver_type`,`approver_id`) WHERE "work_approval_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `idx_work_approval_approver_status` ON `work_approval_proposals` (`org_id`,`approver_type`,`approver_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_budget_scope` ON `work_budget_envelopes` (`org_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_budget_org_id` ON `work_budget_envelopes` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_budget_org_enabled` ON `work_budget_envelopes` (`org_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_budget_reservation_admission_envelope` ON `work_budget_reservations` (`admission_id`,`envelope_id`);--> statement-breakpoint
CREATE INDEX `idx_work_budget_reservation_envelope_active` ON `work_budget_reservations` (`org_id`,`envelope_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_case_dependency` ON `work_case_dependencies` (`org_id`,`prerequisite_case_id`,`dependent_case_id`);--> statement-breakpoint
CREATE INDEX `idx_work_case_dependency_to` ON `work_case_dependencies` (`org_id`,`dependent_case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_case_item` ON `work_case_items` (`org_id`,`case_id`,`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_case_items_work` ON `work_case_items` (`org_id`,`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_cases_org_id` ON `work_cases` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_cases_org_stage` ON `work_cases` (`org_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_cases_project` ON `work_cases` (`org_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_work_interaction_responses_cursor` ON `work_interaction_responses` (`org_id`,`interaction_id`,`responded_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_interactions_org_id` ON `work_interactions` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_interactions_target_status` ON `work_interactions` (`org_id`,`target_type`,`target_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_interactions_work` ON `work_interactions` (`org_id`,`work_item_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_milestone_dependency` ON `work_milestone_dependencies` (`org_id`,`prerequisite_milestone_id`,`dependent_milestone_id`);--> statement-breakpoint
CREATE INDEX `idx_work_milestone_dependency_to` ON `work_milestone_dependencies` (`org_id`,`dependent_milestone_id`);--> statement-breakpoint
CREATE INDEX `idx_work_milestone_items_work` ON `work_milestone_items` (`org_id`,`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_milestones_org_id` ON `work_milestones` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_milestones_project_status` ON `work_milestones` (`org_id`,`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_work_project_health_observed` ON `work_project_health_judgments` (`org_id`,`project_id`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_resource_pool_key` ON `work_resource_pools` (`org_id`,`resource_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_resource_pool_org_id` ON `work_resource_pools` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_resource_reservation_admission_key` ON `work_resource_reservations` (`admission_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `idx_work_resource_reservation_pool_active` ON `work_resource_reservations` (`org_id`,`pool_id`,`state`,`expires_at`);--> statement-breakpoint
INSERT INTO `work_resource_pools` (`id`,`org_id`,`resource_key`,`allocation_mode`,`capacity`,`enabled`,`metadata`,`created_at`,`updated_at`,`version`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), scoped.`org_id`, scoped.`resource_key`, 'exclusive', 1, 1,
	json_object('migratedFrom','work_items.resource_scopes'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1
FROM (
	SELECT DISTINCT item.`org_id`, json_each.`value` AS `resource_key`
	FROM `work_items` item, json_each(CASE WHEN json_valid(item.`resource_scopes`) THEN item.`resource_scopes` ELSE '[]' END)
	WHERE json_each.`type` = 'text' AND length(json_each.`value`) > 0
) scoped;--> statement-breakpoint
INSERT INTO `work_resource_requirements` (`org_id`,`work_item_id`,`resource_key`,`quantity`,`created_at`,`updated_at`)
SELECT DISTINCT item.`org_id`, item.`id`, json_each.`value`, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `work_items` item, json_each(CASE WHEN json_valid(item.`resource_scopes`) THEN item.`resource_scopes` ELSE '[]' END)
WHERE json_each.`type` = 'text' AND length(json_each.`value`) > 0;--> statement-breakpoint
INSERT INTO `work_budget_envelopes` (`id`,`org_id`,`scope_type`,`scope_id`,`limit_micros`,`reservation_micros`,`currency`,`enabled`,`created_at`,`updated_at`,`version`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), item.`org_id`, 'work_item', item.`id`, item.`budget_limit_micros`, item.`budget_limit_micros`, 'USD', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1
FROM `work_items` item WHERE item.`budget_limit_micros` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `resource_scopes`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `budget_limit_micros`;
