CREATE TABLE `memory_entities` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`merged_into_entity_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entities_merged_into_entity_id_memory_entities_id_fk` FOREIGN KEY (`merged_into_entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_name" CHECK(length(trim("display_name")) > 0 AND length("normalized_name") > 0),
	CONSTRAINT "chk_memory_entity_version" CHECK("version" >= 0),
	CONSTRAINT "chk_memory_entity_merge_state" CHECK(("status" = 'merged' AND "merged_into_entity_id" IS NOT NULL AND "merged_into_entity_id" != "id") OR ("status" != 'merged' AND "merged_into_entity_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `memory_entity_aliases` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`surface_form` text NOT NULL,
	`normalized_form` text NOT NULL,
	`alias_kind` text NOT NULL,
	`locale` text DEFAULT 'und' NOT NULL,
	`confidence` real NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`source_mention_id` text,
	`valid_from` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entity_aliases_entity_id_memory_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_aliases_source_mention_id_memory_entity_mentions_id_fk` FOREIGN KEY (`source_mention_id`) REFERENCES `memory_entity_mentions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_alias_confidence" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "chk_memory_entity_alias_validity" CHECK("valid_to" IS NULL OR datetime("valid_to") > datetime("valid_from"))
);
--> statement-breakpoint
CREATE TABLE `memory_entity_mentions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`source_fact_id` text,
	`source_uri` text,
	`source_content_hash` text,
	`source_session_id` text,
	`source_run_id` text,
	`surface_form` text NOT NULL,
	`normalized_form` text NOT NULL,
	`proposed_type` text NOT NULL,
	`char_start` integer,
	`char_end` integer,
	`extractor` text NOT NULL,
	`extractor_version` text NOT NULL,
	`model_id` text,
	`harness_version_id` text,
	`confidence` real NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entity_mentions_source_fact_id_memory_facts_id_fk` FOREIGN KEY (`source_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_mention_surface" CHECK(length(trim("surface_form")) > 0 AND length("normalized_form") > 0),
	CONSTRAINT "chk_memory_entity_mention_confidence" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "chk_memory_entity_mention_span" CHECK(("char_start" IS NULL AND "char_end" IS NULL) OR ("char_start" >= 0 AND "char_end" > "char_start"))
);
--> statement-breakpoint
CREATE TABLE `memory_entity_resolution_decisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`client_proposal_key` text NOT NULL,
	`operation` text NOT NULL,
	`mention_id` text,
	`alias_id` text,
	`source_entity_id` text,
	`target_entity_id` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`confidence` real NOT NULL,
	`rationale` text NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` text NOT NULL,
	`reviewed_by_type` text,
	`reviewed_by_id` text,
	`review_rationale` text,
	`source_run_id` text,
	`expected_mention_version` integer NOT NULL,
	`expected_head_decision_id` text,
	`expected_entity_version` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`supersedes_decision_id` text,
	`rollback_of_decision_id` text,
	`inverse` text NOT NULL,
	`proposed_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`reviewed_at` text,
	`applied_at` text,
	CONSTRAINT `fk_memory_entity_resolution_decisions_mention_id_memory_entity_mentions_id_fk` FOREIGN KEY (`mention_id`) REFERENCES `memory_entity_mentions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolution_decisions_alias_id_memory_entity_aliases_id_fk` FOREIGN KEY (`alias_id`) REFERENCES `memory_entity_aliases`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolution_decisions_source_entity_id_memory_entities_id_fk` FOREIGN KEY (`source_entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolution_decisions_target_entity_id_memory_entities_id_fk` FOREIGN KEY (`target_entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolution_decisions_supersedes_decision_id_memory_entity_resolution_decisions_id_fk` FOREIGN KEY (`supersedes_decision_id`) REFERENCES `memory_entity_resolution_decisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolution_decisions_rollback_of_decision_id_memory_entity_resolution_decisions_id_fk` FOREIGN KEY (`rollback_of_decision_id`) REFERENCES `memory_entity_resolution_decisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_resolution_confidence" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "chk_memory_entity_resolution_versions" CHECK("expected_mention_version" >= 0 AND "version" >= 0 AND ("expected_entity_version" IS NULL OR "expected_entity_version" >= 0)),
	CONSTRAINT "chk_memory_entity_resolution_review_pair" CHECK(("reviewed_by_type" IS NULL AND "reviewed_by_id" IS NULL) OR ("reviewed_by_type" IS NOT NULL AND "reviewed_by_id" IS NOT NULL)),
	CONSTRAINT "chk_memory_entity_resolution_independence" CHECK("reviewed_by_id" IS NULL OR "reviewed_by_type" != "proposed_by_type" OR "reviewed_by_id" != "proposed_by_id"),
	CONSTRAINT "chk_memory_entity_resolution_review_state" CHECK(("status" = 'proposed' AND "reviewed_by_id" IS NULL AND "reviewed_at" IS NULL AND "applied_at" IS NULL) OR ("status" = 'rejected' AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "applied_at" IS NULL) OR ("status" = 'accepted' AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "applied_at" IS NOT NULL)),
	CONSTRAINT "chk_memory_entity_resolution_operation_shape" CHECK(("operation" IN ('link_mention', 'reassign_mention') AND "mention_id" IS NOT NULL AND "target_entity_id" IS NOT NULL AND "rollback_of_decision_id" IS NULL) OR ("operation" = 'rollback' AND "mention_id" IS NOT NULL AND "rollback_of_decision_id" IS NOT NULL) OR ("operation" = 'link_alias' AND "alias_id" IS NOT NULL AND "target_entity_id" IS NOT NULL) OR ("operation" IN ('merge_entities', 'split_entity') AND "source_entity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `memory_entity_resolution_heads` (
	`mention_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`current_resolution_id` text,
	`current_entity_id` text,
	`last_decision_id` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entity_resolution_heads_mention_id_memory_entity_mentions_id_fk` FOREIGN KEY (`mention_id`) REFERENCES `memory_entity_mentions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_entity_resolution_heads_current_entity_id_memory_entities_id_fk` FOREIGN KEY (`current_entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_head_version" CHECK("version" >= 0),
	CONSTRAINT "chk_memory_entity_head_shape" CHECK(("current_resolution_id" IS NULL AND "current_entity_id" IS NULL AND "last_decision_id" IS NULL) OR ("current_resolution_id" IS NOT NULL AND "last_decision_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `memory_entity_resolutions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`mention_id` text NOT NULL,
	`entity_id` text,
	`decision_id` text NOT NULL,
	`resolution_kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`confidence` real NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entity_resolutions_mention_id_memory_entity_mentions_id_fk` FOREIGN KEY (`mention_id`) REFERENCES `memory_entity_mentions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolutions_entity_id_memory_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolutions_decision_id_memory_entity_resolution_decisions_id_fk` FOREIGN KEY (`decision_id`) REFERENCES `memory_entity_resolution_decisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_resolution_shape" CHECK(("resolution_kind" = 'linked' AND "entity_id" IS NOT NULL) OR ("resolution_kind" = 'unresolved' AND "entity_id" IS NULL)),
	CONSTRAINT "chk_memory_entity_resolution_confidence" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "chk_memory_entity_resolution_validity" CHECK(("status" = 'active' AND "valid_to" IS NULL) OR ("status" = 'revoked' AND "valid_to" IS NOT NULL AND datetime("valid_to") >= datetime("valid_from")))
);
--> statement-breakpoint
CREATE TABLE `memory_fact_citation_backfills` (
	`organization_id` text PRIMARY KEY,
	`source` text NOT NULL,
	`fact_id` text NOT NULL,
	`done` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_fact_citations` (
	`organization_id` text NOT NULL,
	`cited_fact_id` text NOT NULL,
	`consolidated_fact_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `memory_fact_citations_pk` PRIMARY KEY(`consolidated_fact_id`, `cited_fact_id`),
	CONSTRAINT `fk_memory_fact_citations_consolidated_fact_id_memory_facts_id_fk` FOREIGN KEY (`consolidated_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_domains` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`description` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `uniq_domain_org_name` UNIQUE(`organization_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `memory_edges` (
	`id` text PRIMARY KEY,
	`source_fact_id` text NOT NULL,
	`target_fact_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`strength` real DEFAULT 0.5 NOT NULL,
	`context` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_memory_edges_source_fact_id_memory_facts_id_fk` FOREIGN KEY (`source_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_edges_target_fact_id_memory_facts_id_fk` FOREIGN KEY (`target_fact_id`) REFERENCES `memory_facts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uniq_edge` UNIQUE(`source_fact_id`,`target_fact_id`,`relation_type`)
);
--> statement-breakpoint
CREATE TABLE `memory_facts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`domain_id` text,
	`content` text NOT NULL,
	`summary` text,
	`fact_type` text NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`valid_from` text DEFAULT (CURRENT_TIMESTAMP),
	`valid_to` text,
	`status` text DEFAULT 'active',
	`source` text,
	`source_session_id` text,
	`source_url` text,
	`source_hash` text,
	`embedding_id` text,
	`topic_key` text,
	`memory_scope` text DEFAULT 'tedi',
	`use_policy` text DEFAULT 'can_use_as_evidence',
	`review_status` text DEFAULT 'pending',
	`metadata` text,
	`priority` text DEFAULT 'active',
	`visibility` text DEFAULT 'private',
	`promoted_from` text,
	`promoted_at` text,
	`last_verified_at` text,
	`last_accessed_at` text,
	`access_count` integer DEFAULT 0 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_memory_facts_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `graph_projection_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL UNIQUE,
	`organization_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`poisoned_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_org_id` ON `memory_entities` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_candidate` ON `memory_entities` (`organization_id`,`entity_type`,`normalized_name`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_merge_target` ON `memory_entities` (`organization_id`,`merged_into_entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_alias` ON `memory_entity_aliases` (`organization_id`,`entity_id`,`normalized_form`,`locale`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_alias_lookup` ON `memory_entity_aliases` (`organization_id`,`normalized_form`,`review_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_mention_occurrence` ON `memory_entity_mentions` (`organization_id`,`occurrence_key`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_mention_source_fact` ON `memory_entity_mentions` (`organization_id`,`source_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_mention_candidate` ON `memory_entity_mentions` (`organization_id`,`proposed_type`,`normalized_form`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_resolution_proposal` ON `memory_entity_resolution_decisions` (`organization_id`,`client_proposal_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_resolution_rollback` ON `memory_entity_resolution_decisions` (`rollback_of_decision_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_resolution_mention` ON `memory_entity_resolution_decisions` (`organization_id`,`mention_id`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_resolution_status` ON `memory_entity_resolution_decisions` (`organization_id`,`status`,`proposed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_head_org_mention` ON `memory_entity_resolution_heads` (`organization_id`,`mention_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_head_current` ON `memory_entity_resolution_heads` (`organization_id`,`current_entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_resolution_decision` ON `memory_entity_resolutions` (`decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_memory_entity_resolution_active` ON `memory_entity_resolutions` (`organization_id`,`mention_id`) WHERE "memory_entity_resolutions"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_memory_entity_resolution_entity` ON `memory_entity_resolutions` (`organization_id`,`entity_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memory_entity_resolution_temporal` ON `memory_entity_resolutions` (`organization_id`,`mention_id`,`valid_from`,`valid_to`);--> statement-breakpoint
CREATE INDEX `idx_memory_fact_citations_org_cited` ON `memory_fact_citations` (`organization_id`,`cited_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_domains_org` ON `memory_domains` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_domains_parent` ON `memory_domains` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_source` ON `memory_edges` (`source_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_target` ON `memory_edges` (`target_fact_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_edges_type` ON `memory_edges` (`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_priority_rank` ON `memory_facts` (`organization_id`,`priority`,`archived_at`,`confidence`,`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_domain` ON `memory_facts` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_type` ON `memory_facts` (`fact_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_confidence` ON `memory_facts` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_source` ON `memory_facts` (`source`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_source_id` ON `memory_facts` (`organization_id`,`source`,`id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_type_rank` ON `memory_facts` (`organization_id`,`fact_type`,`archived_at`,`valid_to`,`confidence`,`last_accessed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_live_rank` ON `memory_facts` (`organization_id`,`archived_at`,`valid_to`,`confidence`,`last_accessed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_recall_time` ON `memory_facts` (`organization_id`,datetime(coalesce("valid_from", "created_at")));--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_recall_until` ON `memory_facts` (`organization_id`,datetime("valid_to"));--> statement-breakpoint
CREATE INDEX `idx_memory_facts_status` ON `memory_facts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_org_domain` ON `memory_facts` (`organization_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_visibility` ON `memory_facts` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_priority` ON `memory_facts` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_topic_key` ON `memory_facts` (`organization_id`,`topic_key`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_scope` ON `memory_facts` (`organization_id`,`memory_scope`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_created` ON `memory_facts` (`organization_id`,`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_accessed` ON `memory_facts` (`organization_id`,`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_flywheel_updated` ON `memory_facts` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_visibility_policy_updated` ON `memory_facts` (`organization_id`,`visibility`,`review_status`,`use_policy`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_use_policy` ON `memory_facts` (`use_policy`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_review_status` ON `memory_facts` (`review_status`);--> statement-breakpoint
CREATE INDEX `memory_facts_tedi_domain_idx` ON `memory_facts` (`tedi_id`,`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_org_sequence` ON `graph_projection_outbox` (`organization_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_entity` ON `graph_projection_outbox` (`organization_id`,`entity_kind`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_retry` ON `graph_projection_outbox` (`poisoned_at`,`next_attempt_at`,`sequence`);