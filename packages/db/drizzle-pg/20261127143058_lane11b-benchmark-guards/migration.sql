-- Keep suite revisions, locked definitions and recorded evidence atomic on Postgres.
CREATE FUNCTION graph_benchmark_case_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM graph_retrieval_benchmark_suites
 WHERE id = NEW.suite_id AND organization_id = NEW.organization_id
   AND status = 'draft' AND revision = NEW.suite_revision FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'benchmark suite is not an editable draft at the expected revision';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_case_insert_guard BEFORE INSERT ON graph_retrieval_benchmark_cases
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_case_insert_guard();
--> statement-breakpoint
CREATE FUNCTION graph_benchmark_case_revision_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE graph_retrieval_benchmark_suites
 SET revision = revision + 1, case_count = case_count + 1, updated_at = NEW.created_at
 WHERE id = NEW.suite_id AND organization_id = NEW.organization_id
   AND status = 'draft' AND revision = NEW.suite_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'benchmark suite revision CAS failed'; END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_case_revision_advance AFTER INSERT ON graph_retrieval_benchmark_cases
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_case_revision_advance();
--> statement-breakpoint
CREATE FUNCTION graph_benchmark_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'benchmark evidence is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_case_immutable BEFORE UPDATE OR DELETE ON graph_retrieval_benchmark_cases
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_immutable();
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_result_immutable BEFORE UPDATE OR DELETE ON graph_retrieval_benchmark_results
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_immutable();
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_graduation_immutable BEFORE UPDATE OR DELETE ON graph_retrieval_graduation_evaluations
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_immutable();
--> statement-breakpoint
CREATE FUNCTION graph_benchmark_locked_suite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('locked', 'retired') THEN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'locked benchmark suites are immutable'; END IF;
  IF ROW(NEW.organization_id, NEW.name, NEW.version, NEW.split, NEW.revision,
         NEW.case_count, NEW.definition_checksum, NEW.source_commit, NEW.artifact_uri,
         NEW.created_by_type, NEW.created_by_id, NEW.locked_at)
     IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.name, OLD.version, OLD.split, OLD.revision,
         OLD.case_count, OLD.definition_checksum, OLD.source_commit, OLD.artifact_uri,
         OLD.created_by_type, OLD.created_by_id, OLD.locked_at)
     OR (OLD.status = 'retired' AND NEW.status <> 'retired')
     OR (OLD.status = 'locked' AND NEW.status NOT IN ('locked', 'retired')) THEN
   RAISE EXCEPTION 'locked benchmark suite definition is immutable';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_locked_suite_guard BEFORE UPDATE OR DELETE ON graph_retrieval_benchmark_suites
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_locked_suite_guard();
--> statement-breakpoint
CREATE FUNCTION graph_benchmark_run_suite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM graph_retrieval_benchmark_suites
 WHERE id = NEW.suite_id AND organization_id = NEW.organization_id
   AND status = 'locked' AND definition_checksum = NEW.suite_checksum FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'benchmark run requires the exact locked suite'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_run_suite_guard BEFORE INSERT ON graph_retrieval_benchmark_runs
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_run_suite_guard();
--> statement-breakpoint
CREATE FUNCTION graph_benchmark_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM graph_retrieval_benchmark_runs r
 JOIN graph_retrieval_benchmark_cases c ON c.suite_id = r.suite_id
   AND c.id = NEW.case_id AND c.organization_id = r.organization_id
 WHERE r.id = NEW.run_id AND r.organization_id = NEW.organization_id
   AND r.status = 'running' FOR SHARE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'benchmark result does not belong to a running suite case'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER graph_benchmark_result_guard BEFORE INSERT ON graph_retrieval_benchmark_results
 FOR EACH ROW EXECUTE FUNCTION graph_benchmark_result_guard();

--> statement-breakpoint
ALTER TABLE machine_tool_calls ADD CONSTRAINT chk_machine_tool_calls_bounds
 CHECK (length(input) <= 220000 AND (result IS NULL OR length(result) <= 20000)
        AND (error IS NULL OR length(error) <= 1000));
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_suites ADD CONSTRAINT chk_graph_benchmark_suite_version
 CHECK (version > 0 AND revision >= 0 AND case_count >= 0);
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_suites ADD CONSTRAINT chk_graph_benchmark_suite_lifecycle
 CHECK ((status = 'draft' AND locked_at IS NULL AND retired_at IS NULL AND definition_checksum IS NULL)
     OR (status = 'locked' AND locked_at IS NOT NULL AND retired_at IS NULL AND length(definition_checksum) > 0)
     OR (status = 'retired' AND locked_at IS NOT NULL AND retired_at IS NOT NULL AND length(definition_checksum) > 0));
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_cases ADD CONSTRAINT chk_graph_benchmark_case_shape
 CHECK (length(trim(query)) > 0 AND length(checksum) > 0 AND suite_revision >= 0);
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_cases ADD CONSTRAINT chk_graph_benchmark_case_expected
 CHECK (jsonb_array_length(expected_fact_ids) > 0 OR jsonb_array_length(expected_edges) > 0
        OR jsonb_array_length(expected_paths) > 0);
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_runs ADD CONSTRAINT chk_graph_benchmark_run_totals
 CHECK (case_count >= 0 AND total_input_tokens >= 0 AND total_output_tokens >= 0
        AND total_latency_ms >= 0 AND total_cost_usd >= 0);
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_runs ADD CONSTRAINT chk_graph_benchmark_run_lifecycle
 CHECK ((status = 'running' AND completed_at IS NULL AND aggregate_metrics IS NULL)
     OR (status = 'completed' AND completed_at IS NOT NULL AND aggregate_metrics IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND completed_at IS NOT NULL AND failure_reason IS NOT NULL));
--> statement-breakpoint
ALTER TABLE graph_retrieval_benchmark_results ADD CONSTRAINT chk_graph_benchmark_result_cost
 CHECK (input_tokens >= 0 AND output_tokens >= 0 AND latency_ms >= 0 AND cost_usd >= 0);
--> statement-breakpoint
ALTER TABLE graph_retrieval_graduation_evaluations ADD CONSTRAINT chk_graph_benchmark_graduation_distinct_runs
 CHECK (baseline_run_id <> graph_run_id);
