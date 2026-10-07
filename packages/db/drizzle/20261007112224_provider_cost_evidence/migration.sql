CREATE TABLE `billing_provider_cost_evidence_versions` (
	`id` text PRIMARY KEY,
	`original_org_id` text NOT NULL,
	`source_gateway_id` text NOT NULL,
	`gateway_log_id` text NOT NULL,
	`source_call_id` text NOT NULL,
	`scope_digest` text NOT NULL,
	`original_source_digest` text NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`provider` text NOT NULL,
	`native_model` text NOT NULL,
	`native_facts_receipt_digest` text NOT NULL,
	`basis_facts_digest` text NOT NULL,
	`financial_manifest_digest` text NOT NULL,
	`financial_work_id` text NOT NULL,
	`financial_spec_revision` text NOT NULL,
	`approval_proposal_id` text NOT NULL,
	`approval_decision_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`created_by_actor_type` text NOT NULL,
	`created_by_actor_id` text NOT NULL,
	`created_by_session_id` text NOT NULL,
	`idempotency_digest` text NOT NULL,
	`payload_digest` text NOT NULL,
	`original_tedi_id` text,
	`original_run_id` text,
	`original_work_id` text,
	`original_execution_id` text,
	`original_reservation_id` text,
	`rate_certificate_digest` text,
	`reported_cost_decimal` text,
	`reported_reporter` text,
	`supersedes_evidence_version_id` text,
	`original_source_snapshot` text NOT NULL,
	`deployment_scope` text NOT NULL,
	`rate_certificate_snapshot` text,
	`reported_estimate_snapshot` text,
	`financial_manifest_snapshot` text NOT NULL,
	`approval_decision_snapshot` text NOT NULL,
	`original_source_version` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`provider_estimated_cost_micros` integer NOT NULL,
	`financial_work_version` integer NOT NULL,
	`input_price_micros_per_million` integer,
	`output_price_micros_per_million` integer,
	`cache_read_price_micros_per_million` integer,
	`cache_write_price_micros_per_million` integer,
	`native_usage_known` integer NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`pricing_basis` text NOT NULL,
	CONSTRAINT "chk_provider_cost_evidence_known_safe" CHECK("native_usage_known" = 1
AND "kind" = 'provider_estimate'
AND "currency" = 'USD'
AND length("original_org_id") > 0
AND length("source_gateway_id") > 0
AND length("gateway_log_id") > 0
AND length("source_call_id") > 0
AND length("scope_digest") = 64
AND length("basis_facts_digest") = 64
AND typeof("original_source_version") = 'integer' AND "original_source_version" BETWEEN 0 AND 9007199254740991
AND typeof("input_tokens") = 'integer' AND "input_tokens" BETWEEN 0 AND 9007199254740991
AND typeof("output_tokens") = 'integer' AND "output_tokens" BETWEEN 0 AND 9007199254740991
AND typeof("cache_read_tokens") = 'integer' AND "cache_read_tokens" BETWEEN 0 AND 9007199254740991
AND typeof("cache_write_tokens") = 'integer' AND "cache_write_tokens" BETWEEN 0 AND 9007199254740991
AND typeof("provider_estimated_cost_micros") = 'integer' AND "provider_estimated_cost_micros" BETWEEN 0 AND 9007199254740991
AND typeof("financial_work_version") = 'integer' AND "financial_work_version" BETWEEN 0 AND 9007199254740991
AND "original_source_version" >= 1
AND "financial_work_version" >= 1
AND "cache_read_tokens" <= "input_tokens" - "cache_write_tokens"
AND (("pricing_basis" = 'rate_estimated' AND "rate_certificate_digest" IS NOT NULL AND "rate_certificate_snapshot" IS NOT NULL AND "input_price_micros_per_million" IS NOT NULL AND "output_price_micros_per_million" IS NOT NULL AND "cache_read_price_micros_per_million" IS NOT NULL AND "cache_write_price_micros_per_million" IS NOT NULL AND typeof("input_price_micros_per_million") = 'integer' AND "input_price_micros_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("output_price_micros_per_million") = 'integer' AND "output_price_micros_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_read_price_micros_per_million") = 'integer' AND "cache_read_price_micros_per_million" BETWEEN 0 AND 9007199254740991 AND typeof("cache_write_price_micros_per_million") = 'integer' AND "cache_write_price_micros_per_million" BETWEEN 0 AND 9007199254740991 AND json_valid("rate_certificate_snapshot") AND "reported_estimate_snapshot" IS NULL AND "reported_cost_decimal" IS NULL AND "reported_reporter" IS NULL) OR ("pricing_basis" = 'reported_estimate' AND "rate_certificate_digest" IS NULL AND "rate_certificate_snapshot" IS NULL AND "input_price_micros_per_million" IS NULL AND "output_price_micros_per_million" IS NULL AND "cache_read_price_micros_per_million" IS NULL AND "cache_write_price_micros_per_million" IS NULL AND "reported_estimate_snapshot" IS NOT NULL AND "reported_cost_decimal" IS NOT NULL AND "reported_reporter" IS NOT NULL AND "reported_reporter" = 'cloudflare_ai_gateway' AND length("reported_cost_decimal") BETWEEN 1 AND 36 AND json_valid("reported_estimate_snapshot"))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_cost_evidence_original_root` ON `billing_provider_cost_evidence_versions` (`original_org_id`,`source_gateway_id`,`gateway_log_id`,`source_call_id`) WHERE "billing_provider_cost_evidence_versions"."supersedes_evidence_version_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_cost_evidence_child` ON `billing_provider_cost_evidence_versions` (`supersedes_evidence_version_id`) WHERE "billing_provider_cost_evidence_versions"."supersedes_evidence_version_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_provider_cost_evidence_idempotency` ON `billing_provider_cost_evidence_versions` (`idempotency_digest`);--> statement-breakpoint
CREATE INDEX `idx_provider_cost_evidence_org_time_source` ON `billing_provider_cost_evidence_versions` (`original_org_id`,`occurred_at`,`source_call_id`);
--> statement-breakpoint
CREATE TRIGGER provider_cost_evidence_parent_guard BEFORE INSERT ON billing_provider_cost_evidence_versions WHEN NEW.supersedes_evidence_version_id IS NOT NULL BEGIN
SELECT RAISE(ABORT, 'invalid evidence parent') WHERE NEW.supersedes_evidence_version_id = NEW.id OR NOT EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions p WHERE p.id=NEW.supersedes_evidence_version_id AND p.original_org_id=NEW.original_org_id AND p.source_gateway_id=NEW.source_gateway_id AND p.gateway_log_id=NEW.gateway_log_id AND p.source_call_id=NEW.source_call_id AND p.scope_digest=NEW.scope_digest) OR EXISTS(SELECT 1 FROM billing_provider_cost_evidence_versions c WHERE c.supersedes_evidence_version_id=NEW.supersedes_evidence_version_id);
END;
--> statement-breakpoint
CREATE TRIGGER provider_cost_evidence_no_update BEFORE UPDATE ON billing_provider_cost_evidence_versions BEGIN SELECT RAISE(ABORT,'immutable cost evidence'); END;
--> statement-breakpoint
CREATE TRIGGER provider_cost_evidence_no_delete BEFORE DELETE ON billing_provider_cost_evidence_versions BEGIN SELECT RAISE(ABORT,'immutable cost evidence'); END;
