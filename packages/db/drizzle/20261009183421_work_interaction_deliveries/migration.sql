CREATE TABLE `work_interaction_deliveries` (
	`org_id` text NOT NULL,
	`response_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`delivered_at` text,
	`delivered_via` text,
	`acknowledged_at` text,
	`handoff_to` text,
	`handoff_ref` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `pk_work_interaction_deliveries` PRIMARY KEY(`org_id`, `response_id`),
	CONSTRAINT `fk_work_interaction_deliveries_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_deliveries_response_id_work_interaction_responses_id_fk` FOREIGN KEY (`response_id`) REFERENCES `work_interaction_responses`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_delivery_request` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_interaction_delivery_via" CHECK("delivered_via" IS NULL OR "delivered_via" IN ('hook','supervisor_resume','codex_queue','codex_resume','prompt_context','handoff','legacy')),
	CONSTRAINT "chk_work_interaction_delivery_handoff_to" CHECK("handoff_to" IS NULL OR length("handoff_to") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE INDEX `idx_work_interaction_deliveries_request` ON `work_interaction_deliveries` (`org_id`,`interaction_id`);
--> statement-breakpoint
-- Answers recorded before this ledger: delivery unknown, never re-delivered.
INSERT INTO `work_interaction_deliveries` (`org_id`, `response_id`, `interaction_id`, `delivered_at`, `delivered_via`, `updated_at`) SELECT `org_id`, `id`, `interaction_id`, `responded_at`, 'legacy', `responded_at` FROM `work_interaction_responses`;