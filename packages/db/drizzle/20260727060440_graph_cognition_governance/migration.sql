CREATE TABLE `graph_retrieval_benchmark_cases` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`suite_revision` integer NOT NULL,
	`case_key` text NOT NULL,
	`query` text NOT NULL,
	`anchor_fact_ids` text DEFAULT '[]' NOT NULL,
	`expected_fact_ids` text NOT NULL,
	`expected_edges` text DEFAULT '[]' NOT NULL,
	`expected_paths` text DEFAULT '[]' NOT NULL,
	`forbidden_fact_ids` text DEFAULT '[]' NOT NULL,
	`valid_at` text NOT NULL,
	`answer_rubric` text DEFAULT '{}' NOT NULL,
	`artifact_uri` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`difficulty` text DEFAULT 'intermediate' NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_graph_retrieval_benchmark_cases_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_graph_retrieval_benchmark_cases_suite_id_graph_retrieval_benchmark_suites_id_fk` FOREIGN KEY (`suite_id`) REFERENCES `graph_retrieval_benchmark_suites`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_graph_benchmark_case_shape" CHECK(length(trim("query")) > 0 AND length("checksum") > 0 AND "suite_revision" >= 0),
	CONSTRAINT "chk_graph_benchmark_case_expected" CHECK(json_array_length("expected_fact_ids") > 0 OR json_array_length("expected_edges") > 0 OR json_array_length("expected_paths") > 0)
);
--> statement-breakpoint
CREATE TABLE `graph_retrieval_benchmark_results` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`retrieved_fact_ids` text NOT NULL,
	`returned_edges` text DEFAULT '[]' NOT NULL,
	`returned_paths` text DEFAULT '[]' NOT NULL,
	`answer` text,
	`cited_fact_ids` text DEFAULT '[]' NOT NULL,
	`claim_support` text DEFAULT '[]' NOT NULL,
	`metrics` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`passed` integer NOT NULL,
	`failure_reasons` text DEFAULT '[]' NOT NULL,
	`trace_artifact_uri` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_graph_retrieval_benchmark_results_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_graph_retrieval_benchmark_results_run_id_graph_retrieval_benchmark_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `graph_retrieval_benchmark_runs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_graph_retrieval_benchmark_results_case_id_graph_retrieval_benchmark_cases_id_fk` FOREIGN KEY (`case_id`) REFERENCES `graph_retrieval_benchmark_cases`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_graph_benchmark_result_cost" CHECK("input_tokens" >= 0 AND "output_tokens" >= 0 AND "latency_ms" >= 0 AND "cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE `graph_retrieval_benchmark_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`suite_checksum` text NOT NULL,
	`paired_run_key` text NOT NULL,
	`variant` text NOT NULL,
	`retrieval_policy_version` text NOT NULL,
	`harness_version_id` text,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`projection_snapshot` text NOT NULL,
	`seed` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`case_count` integer DEFAULT 0 NOT NULL,
	`aggregate_metrics` text,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`eligible` integer DEFAULT false NOT NULL,
	`trace_artifact_uri` text,
	`failure_reason` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_graph_retrieval_benchmark_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_graph_retrieval_benchmark_runs_suite_id_graph_retrieval_benchmark_suites_id_fk` FOREIGN KEY (`suite_id`) REFERENCES `graph_retrieval_benchmark_suites`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_graph_benchmark_run_totals" CHECK("case_count" >= 0 AND "total_input_tokens" >= 0 AND "total_output_tokens" >= 0 AND "total_latency_ms" >= 0 AND "total_cost_usd" >= 0),
	CONSTRAINT "chk_graph_benchmark_run_lifecycle" CHECK(("status" = 'running' AND "completed_at" IS NULL AND "aggregate_metrics" IS NULL) OR ("status" = 'completed' AND "completed_at" IS NOT NULL AND "aggregate_metrics" IS NOT NULL AND "failure_reason" IS NULL) OR ("status" = 'failed' AND "completed_at" IS NOT NULL AND "failure_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `graph_retrieval_benchmark_suites` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`split` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`case_count` integer DEFAULT 0 NOT NULL,
	`definition_checksum` text,
	`source_commit` text,
	`artifact_uri` text,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`locked_at` text,
	`retired_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_graph_retrieval_benchmark_suites_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_graph_benchmark_suite_version" CHECK("version" > 0 AND "revision" >= 0 AND "case_count" >= 0),
	CONSTRAINT "chk_graph_benchmark_suite_lifecycle" CHECK(("status" = 'draft' AND "locked_at" IS NULL AND "retired_at" IS NULL AND "definition_checksum" IS NULL) OR ("status" = 'locked' AND "locked_at" IS NOT NULL AND "retired_at" IS NULL AND length("definition_checksum") > 0) OR ("status" = 'retired' AND "locked_at" IS NOT NULL AND "retired_at" IS NOT NULL AND length("definition_checksum") > 0))
);
--> statement-breakpoint
CREATE TABLE `graph_retrieval_graduation_evaluations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`baseline_run_id` text NOT NULL,
	`graph_run_id` text NOT NULL,
	`evaluator_version` text NOT NULL,
	`passed` integer NOT NULL,
	`gates` text NOT NULL,
	`paired_metrics` text NOT NULL,
	`projection_snapshot` text NOT NULL,
	`reasons` text NOT NULL,
	`evaluated_at` text NOT NULL,
	CONSTRAINT `fk_graph_retrieval_graduation_evaluations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_graph_retrieval_graduation_evaluations_suite_id_graph_retrieval_benchmark_suites_id_fk` FOREIGN KEY (`suite_id`) REFERENCES `graph_retrieval_benchmark_suites`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_graph_retrieval_graduation_evaluations_baseline_run_id_graph_retrieval_benchmark_runs_id_fk` FOREIGN KEY (`baseline_run_id`) REFERENCES `graph_retrieval_benchmark_runs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_graph_retrieval_graduation_evaluations_graph_run_id_graph_retrieval_benchmark_runs_id_fk` FOREIGN KEY (`graph_run_id`) REFERENCES `graph_retrieval_benchmark_runs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_graph_benchmark_graduation_distinct_runs" CHECK("baseline_run_id" != "graph_run_id")
);
--> statement-breakpoint
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
	CONSTRAINT `fk_memory_entities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `fk_memory_entity_aliases_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `fk_memory_entity_mentions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `fk_memory_entity_resolution_decisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `fk_memory_entity_resolution_heads_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `fk_memory_entity_resolutions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_entity_resolutions_mention_id_memory_entity_mentions_id_fk` FOREIGN KEY (`mention_id`) REFERENCES `memory_entity_mentions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolutions_entity_id_memory_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `memory_entities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_memory_entity_resolutions_decision_id_memory_entity_resolution_decisions_id_fk` FOREIGN KEY (`decision_id`) REFERENCES `memory_entity_resolution_decisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_memory_entity_resolution_shape" CHECK(("resolution_kind" = 'linked' AND "entity_id" IS NOT NULL) OR ("resolution_kind" = 'unresolved' AND "entity_id" IS NULL)),
	CONSTRAINT "chk_memory_entity_resolution_confidence" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "chk_memory_entity_resolution_validity" CHECK(("status" = 'active' AND "valid_to" IS NULL) OR ("status" = 'revoked' AND "valid_to" IS NOT NULL AND datetime("valid_to") >= datetime("valid_from")))
);
--> statement-breakpoint
ALTER TABLE `graph_projection_readiness` ADD `repair_id` text;--> statement-breakpoint
ALTER TABLE `graph_projection_readiness` ADD `repair_phase` text;--> statement-breakpoint
ALTER TABLE `graph_projection_readiness` ADD `repair_cursor` text;--> statement-breakpoint
ALTER TABLE `graph_projection_readiness` ADD `repair_high_water` integer;--> statement-breakpoint
ALTER TABLE `graph_projection_readiness` ADD `repair_started_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_case_key` ON `graph_retrieval_benchmark_cases` (`suite_id`,`case_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_case_checksum` ON `graph_retrieval_benchmark_cases` (`suite_id`,`checksum`);--> statement-breakpoint
CREATE INDEX `idx_graph_benchmark_case_suite` ON `graph_retrieval_benchmark_cases` (`organization_id`,`suite_id`,`case_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_result_case` ON `graph_retrieval_benchmark_results` (`run_id`,`case_id`);--> statement-breakpoint
CREATE INDEX `idx_graph_benchmark_result_run` ON `graph_retrieval_benchmark_results` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_run_pair_variant` ON `graph_retrieval_benchmark_runs` (`organization_id`,`paired_run_key`,`variant`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_run_org_id` ON `graph_retrieval_benchmark_runs` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_graph_benchmark_run_suite` ON `graph_retrieval_benchmark_runs` (`organization_id`,`suite_id`,`status`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_suite_version` ON `graph_retrieval_benchmark_suites` (`organization_id`,`name`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_suite_org_id` ON `graph_retrieval_benchmark_suites` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_graph_benchmark_suite_status` ON `graph_retrieval_benchmark_suites` (`organization_id`,`status`,`split`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_benchmark_graduation_pair` ON `graph_retrieval_graduation_evaluations` (`baseline_run_id`,`graph_run_id`,`evaluator_version`);--> statement-breakpoint
CREATE INDEX `idx_graph_benchmark_graduation_suite` ON `graph_retrieval_graduation_evaluations` (`organization_id`,`suite_id`,`evaluated_at`);--> statement-breakpoint
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

CREATE TRIGGER `graph_projection_memory_facts_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_facts`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory fact organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_domains`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory domain organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_tedis_org_immutable`
BEFORE UPDATE OF `organization_id` ON `tedis`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'tedi organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_rationale_org_immutable`
BEFORE UPDATE OF `org_id` ON `tedi_rationale_records`
WHEN NEW.`org_id` != OLD.`org_id`
BEGIN
	SELECT RAISE(ABORT, 'rationale organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_knowledge_org_immutable`
BEFORE UPDATE OF `organization_id` ON `knowledge_entries`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'knowledge entry organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_skills_org_immutable`
BEFORE UPDATE OF `organization_id` ON `skill_entries`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'skill organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_org_immutable`
BEFORE UPDATE OF `organization_id` ON `org_capabilities`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'capability organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_link_org_immutable`
BEFORE UPDATE OF `organization_id` ON `capability_links`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'capability link organization is immutable');
END;--> statement-breakpoint

CREATE TRIGGER `memory_edges_same_org_insert`
BEFORE INSERT ON `memory_edges`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_facts` source
	JOIN `memory_facts` target
	  ON target.`id` = NEW.`target_fact_id`
	WHERE source.`id` = NEW.`source_fact_id`
	  AND source.`organization_id` = target.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'memory edge endpoints must belong to the same organization');
END;--> statement-breakpoint
CREATE TRIGGER `memory_edges_same_org_update`
BEFORE UPDATE OF `source_fact_id`, `target_fact_id` ON `memory_edges`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_facts` source
	JOIN `memory_facts` target
	  ON target.`id` = NEW.`target_fact_id`
	WHERE source.`id` = NEW.`source_fact_id`
	  AND source.`organization_id` = target.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'memory edge endpoints must belong to the same organization');
END;--> statement-breakpoint
CREATE TRIGGER `tedi_expertise_same_org_insert`
BEFORE INSERT ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `tedis` t
	JOIN `memory_domains` d
	  ON d.`id` = NEW.`domain_id`
	WHERE t.`id` = NEW.`tedi_id`
	  AND t.`organization_id` = d.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'tedi expertise endpoints must belong to the same organization');
END;--> statement-breakpoint
CREATE TRIGGER `tedi_expertise_same_org_update`
BEFORE UPDATE OF `tedi_id`, `domain_id` ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `tedis` t
	JOIN `memory_domains` d
	  ON d.`id` = NEW.`domain_id`
	WHERE t.`id` = NEW.`tedi_id`
	  AND t.`organization_id` = d.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'tedi expertise endpoints must belong to the same organization');
END;--> statement-breakpoint
CREATE TRIGGER `capability_links_same_org_insert`
BEFORE INSERT ON `capability_links`
WHEN NOT EXISTS (
	SELECT 1
	FROM `org_capabilities` c
	WHERE c.`id` = NEW.`capability_id`
	  AND c.`organization_id` = NEW.`organization_id`
)
OR (
	NEW.`entity_kind` = 'skill'
	AND NOT EXISTS (
		SELECT 1 FROM `skill_entries` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'app'
	AND NOT EXISTS (
		SELECT 1 FROM `apps` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'tedi'
	AND NOT EXISTS (
		SELECT 1 FROM `tedis` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'objective'
	AND NOT EXISTS (
		SELECT 1 FROM `tedi_objectives` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`org_id` = NEW.`organization_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'capability link endpoints must belong to the same organization');
END;--> statement-breakpoint
CREATE TRIGGER `capability_links_same_org_update`
BEFORE UPDATE OF `capability_id`, `entity_kind`, `entity_id` ON `capability_links`
WHEN NOT EXISTS (
	SELECT 1
	FROM `org_capabilities` c
	WHERE c.`id` = NEW.`capability_id`
	  AND c.`organization_id` = NEW.`organization_id`
)
OR (
	NEW.`entity_kind` = 'skill'
	AND NOT EXISTS (
		SELECT 1 FROM `skill_entries` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'app'
	AND NOT EXISTS (
		SELECT 1 FROM `apps` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'tedi'
	AND NOT EXISTS (
		SELECT 1 FROM `tedis` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`organization_id` = NEW.`organization_id`
	)
)
OR (
	NEW.`entity_kind` = 'objective'
	AND NOT EXISTS (
		SELECT 1 FROM `tedi_objectives` e
		WHERE e.`id` = NEW.`entity_id`
		  AND e.`org_id` = NEW.`organization_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'capability link endpoints must belong to the same organization');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_memory_edges_update_old_tuple`
BEFORE UPDATE OF `source_fact_id`, `target_fact_id`, `relation_type` ON `memory_edges`
WHEN NEW.`source_fact_id` != OLD.`source_fact_id`
  OR NEW.`target_fact_id` != OLD.`target_fact_id`
  OR NEW.`relation_type` != OLD.`relation_type`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge',
		OLD.`id` || ':old:' || lower(hex(randomblob(8))), 'delete',
		json_object(
			'sourceFactId', OLD.`source_fact_id`,
			'targetFactId', OLD.`target_fact_id`,
			'relationType', OLD.`relation_type`
		)
	FROM `memory_facts` f
	WHERE f.`id` = OLD.`source_fact_id`;
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_update_old_tuple`
BEFORE UPDATE OF `tedi_id`, `domain_id` ON `tedi_expertise`
WHEN NEW.`tedi_id` != OLD.`tedi_id`
  OR NEW.`domain_id` != OLD.`domain_id`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise',
		OLD.`id` || ':old:' || lower(hex(randomblob(8))), 'delete',
		json_object('tediId', OLD.`tedi_id`, 'domainId', OLD.`domain_id`)
	FROM `tedis` t
	WHERE t.`id` = OLD.`tedi_id`;
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_link_update_old_tuple`
BEFORE UPDATE OF `capability_id`, `entity_kind`, `entity_id` ON `capability_links`
WHEN NEW.`capability_id` != OLD.`capability_id`
  OR NEW.`entity_kind` != OLD.`entity_kind`
  OR NEW.`entity_id` != OLD.`entity_id`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES (
		lower(hex(randomblob(16))),
		OLD.`organization_id`,
		'capability_link',
		OLD.`id` || ':old:' || lower(hex(randomblob(8))),
		'delete',
		json_object(
			'capabilityId', OLD.`capability_id`,
			'entityKind', OLD.`entity_kind`,
			'entityId', OLD.`entity_id`
		)
	);
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_memory_facts_incident_edges_delete`
BEFORE DELETE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT
		lower(hex(randomblob(16))),
		OLD.`organization_id`,
		'edge',
		e.`id` || ':incident:' || lower(hex(randomblob(8))),
		'delete',
		json_object(
			'sourceFactId', e.`source_fact_id`,
			'targetFactId', e.`target_fact_id`,
			'relationType', e.`relation_type`
		)
	FROM `memory_edges` e
	WHERE e.`source_fact_id` = OLD.`id`
	   OR e.`target_fact_id` = OLD.`id`;
END;--> statement-breakpoint

CREATE TRIGGER `memory_entities_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entities`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory entity organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_aliases_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_aliases`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory entity alias organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_mentions_no_update`
BEFORE UPDATE ON `memory_entity_mentions`
BEGIN
	SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_mentions_no_delete`
BEFORE DELETE ON `memory_entity_mentions`
BEGIN
	SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_terminal_no_update`
BEFORE UPDATE ON `memory_entity_resolution_decisions`
WHEN OLD.`status` IN ('accepted', 'rejected')
BEGIN
	SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_terminal_no_delete`
BEFORE DELETE ON `memory_entity_resolution_decisions`
WHEN OLD.`status` IN ('accepted', 'rejected')
BEGIN
	SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_resolution_decisions`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'entity resolution decision organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_heads_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_resolution_heads`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'entity resolution head organization is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolution_acceptance_guard`
BEFORE INSERT ON `memory_entity_resolutions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_entity_resolution_decisions` d
	JOIN `memory_entity_resolution_heads` h
	  ON h.`organization_id` = d.`organization_id`
	 AND h.`mention_id` = d.`mention_id`
	WHERE d.`id` = NEW.`decision_id`
	  AND d.`organization_id` = NEW.`organization_id`
	  AND d.`mention_id` = NEW.`mention_id`
	  AND d.`status` = 'accepted'
	  AND h.`current_resolution_id` = NEW.`id`
	  AND h.`current_entity_id` IS NEW.`entity_id`
	  AND h.`last_decision_id` = d.`id`
	  AND (
			(NEW.`entity_id` IS NULL
			 AND d.`operation` = 'rollback'
			 AND d.`target_entity_id` IS NULL)
			OR EXISTS (
				SELECT 1
				FROM `memory_entities` e
				WHERE e.`id` = NEW.`entity_id`
				  AND e.`organization_id` = NEW.`organization_id`
				  AND e.`id` = d.`target_entity_id`
				  AND e.`status` = 'active'
				  AND e.`version` = d.`expected_entity_version`
			)
	  )
)
BEGIN
	SELECT RAISE(ABORT, 'entity resolution acceptance fence failed');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolutions_update_guard`
BEFORE UPDATE ON `memory_entity_resolutions`
WHEN NEW.`organization_id` != OLD.`organization_id`
  OR NEW.`mention_id` != OLD.`mention_id`
  OR NEW.`entity_id` IS NOT OLD.`entity_id`
  OR NEW.`decision_id` != OLD.`decision_id`
  OR NEW.`resolution_kind` != OLD.`resolution_kind`
  OR NEW.`confidence` != OLD.`confidence`
  OR NEW.`valid_from` != OLD.`valid_from`
  OR NEW.`created_at` != OLD.`created_at`
  OR OLD.`status` != 'active'
  OR NEW.`status` != 'revoked'
  OR NEW.`valid_to` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'entity resolutions only permit active-to-revoked closure');
END;--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolutions_no_delete`
BEFORE DELETE ON `memory_entity_resolutions`
BEGIN
	SELECT RAISE(ABORT, 'entity resolutions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_insert`
AFTER INSERT ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_update`
AFTER UPDATE ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_delete`
AFTER DELETE ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'entity', OLD.`id`, 'delete');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entity_resolutions_insert`
AFTER INSERT ON `memory_entity_resolutions`
WHEN NEW.`resolution_kind` = 'linked'
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity_resolution', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entity_resolutions_revoke`
AFTER UPDATE OF `status`, `valid_to` ON `memory_entity_resolutions`
WHEN OLD.`status` = 'active' AND NEW.`status` = 'revoked'
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES (
		lower(hex(randomblob(16))),
		NEW.`organization_id`,
		'entity_resolution',
		NEW.`id`,
		'delete',
		json_object(
			'mentionId', NEW.`mention_id`,
			'factId', (
				SELECT `source_fact_id`
				FROM `memory_entity_mentions`
				WHERE `id` = NEW.`mention_id`
				  AND `organization_id` = NEW.`organization_id`
			),
			'entityId', NEW.`entity_id`,
			'decisionId', NEW.`decision_id`,
			'validTo', NEW.`valid_to`
		)
	);
END;--> statement-breakpoint

CREATE TRIGGER `graph_benchmark_case_insert_guard`
BEFORE INSERT ON `graph_retrieval_benchmark_cases`
WHEN NOT EXISTS (
	SELECT 1
	FROM `graph_retrieval_benchmark_suites` s
	WHERE s.`id` = NEW.`suite_id`
	  AND s.`organization_id` = NEW.`organization_id`
	  AND s.`status` = 'draft'
	  AND s.`revision` = NEW.`suite_revision`
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark suite is not an editable draft at the expected revision');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_case_revision_advance`
AFTER INSERT ON `graph_retrieval_benchmark_cases`
BEGIN
	UPDATE `graph_retrieval_benchmark_suites`
	SET `revision` = `revision` + 1,
		`case_count` = `case_count` + 1,
		`updated_at` = NEW.`created_at`
	WHERE `id` = NEW.`suite_id`
	  AND `organization_id` = NEW.`organization_id`
	  AND `status` = 'draft'
	  AND `revision` = NEW.`suite_revision`;
	SELECT RAISE(ABORT, 'benchmark suite revision CAS failed')
	WHERE changes() != 1;
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_case_no_update`
BEFORE UPDATE ON `graph_retrieval_benchmark_cases`
BEGIN
	SELECT RAISE(ABORT, 'benchmark cases are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_case_no_delete`
BEFORE DELETE ON `graph_retrieval_benchmark_cases`
BEGIN
	SELECT RAISE(ABORT, 'benchmark cases are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_locked_suite_definition_guard`
BEFORE UPDATE ON `graph_retrieval_benchmark_suites`
WHEN OLD.`status` IN ('locked', 'retired')
 AND (
	NEW.`organization_id` != OLD.`organization_id`
	OR NEW.`name` != OLD.`name`
	OR NEW.`version` != OLD.`version`
	OR NEW.`split` != OLD.`split`
	OR NEW.`revision` != OLD.`revision`
	OR NEW.`case_count` != OLD.`case_count`
	OR NEW.`definition_checksum` != OLD.`definition_checksum`
	OR NEW.`source_commit` IS NOT OLD.`source_commit`
	OR NEW.`artifact_uri` IS NOT OLD.`artifact_uri`
	OR NEW.`created_by_type` != OLD.`created_by_type`
	OR NEW.`created_by_id` != OLD.`created_by_id`
	OR NEW.`locked_at` != OLD.`locked_at`
	OR (OLD.`status` = 'retired' AND NEW.`status` != 'retired')
	OR (OLD.`status` = 'locked' AND NEW.`status` NOT IN ('locked', 'retired'))
 )
BEGIN
	SELECT RAISE(ABORT, 'locked benchmark suite definition is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_locked_suite_no_delete`
BEFORE DELETE ON `graph_retrieval_benchmark_suites`
WHEN OLD.`status` IN ('locked', 'retired')
BEGIN
	SELECT RAISE(ABORT, 'locked benchmark suites are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_run_suite_guard`
BEFORE INSERT ON `graph_retrieval_benchmark_runs`
WHEN NOT EXISTS (
	SELECT 1
	FROM `graph_retrieval_benchmark_suites` s
	WHERE s.`id` = NEW.`suite_id`
	  AND s.`organization_id` = NEW.`organization_id`
	  AND s.`status` = 'locked'
	  AND s.`definition_checksum` = NEW.`suite_checksum`
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark run requires the exact locked suite');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_result_guard`
BEFORE INSERT ON `graph_retrieval_benchmark_results`
WHEN NOT EXISTS (
	SELECT 1
	FROM `graph_retrieval_benchmark_runs` r
	JOIN `graph_retrieval_benchmark_cases` c
	  ON c.`suite_id` = r.`suite_id`
	 AND c.`id` = NEW.`case_id`
	 AND c.`organization_id` = r.`organization_id`
	WHERE r.`id` = NEW.`run_id`
	  AND r.`organization_id` = NEW.`organization_id`
	  AND r.`status` = 'running'
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark result does not belong to a running suite case');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_result_no_update`
BEFORE UPDATE ON `graph_retrieval_benchmark_results`
BEGIN
	SELECT RAISE(ABORT, 'benchmark results are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_result_no_delete`
BEFORE DELETE ON `graph_retrieval_benchmark_results`
BEGIN
	SELECT RAISE(ABORT, 'benchmark results are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_graduation_no_update`
BEFORE UPDATE ON `graph_retrieval_graduation_evaluations`
BEGIN
	SELECT RAISE(ABORT, 'graduation evaluations are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `graph_benchmark_graduation_no_delete`
BEFORE DELETE ON `graph_retrieval_graduation_evaluations`
BEGIN
	SELECT RAISE(ABORT, 'graduation evaluations are immutable');
END;--> statement-breakpoint

INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'entity', `id`, 'upsert'
FROM `memory_entities`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'entity_resolution', `id`, 'upsert'
FROM `memory_entity_resolutions`
WHERE `resolution_kind` = 'linked';--> statement-breakpoint
UPDATE `graph_projection_readiness`
SET `state` = 'catching_up',
	`reason` = 'governed_baseline_repair_required',
	`repair_id` = NULL,
	`repair_phase` = NULL,
	`repair_cursor` = NULL,
	`repair_high_water` = NULL,
	`repair_started_at` = NULL,
	`updated_at` = CURRENT_TIMESTAMP;
