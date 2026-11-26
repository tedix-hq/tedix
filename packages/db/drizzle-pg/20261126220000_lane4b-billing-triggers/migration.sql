-- Port the live billing_* triggers to Postgres functions and add the
-- billing_provider_usage dedupe indexes plus the rollup id sequence that
-- rebuildCostRollupDay draws from. Mirrors the D1 triggers verbatim:
-- call-cost writes mark the organization-day stale, provider cost evidence
-- does the same through the original call snapshot, and stale stays a
-- boolean on Postgres.

DO $install$

BEGIN

LOCK TABLE billing_cost_rollups, tedi_call_costs, billing_provider_cost_evidence_versions IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE billing_cost_rollups_id_seq;

CREATE FUNCTION billing_cost_rollups_stale_call_insert_fn() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
	UPDATE billing_cost_rollups SET stale = true
	WHERE organization_id = NEW."org_id" AND day = substr(NEW."snapshot_at", 1, 10) AND stale = false;
	RETURN NULL;
END;
$function$;

CREATE TRIGGER billing_cost_rollups_stale_call_insert
AFTER INSERT ON tedi_call_costs
FOR EACH ROW WHEN (NEW."org_id" IS NOT NULL)
EXECUTE FUNCTION billing_cost_rollups_stale_call_insert_fn();

CREATE FUNCTION billing_cost_rollups_stale_call_update_fn() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
	UPDATE billing_cost_rollups SET stale = true
	WHERE organization_id = OLD."org_id" AND day = substr(OLD."snapshot_at", 1, 10) AND stale = false;
	UPDATE billing_cost_rollups SET stale = true
	WHERE organization_id = NEW."org_id" AND day = substr(NEW."snapshot_at", 1, 10) AND stale = false;
	RETURN NULL;
END;
$function$;

CREATE TRIGGER billing_cost_rollups_stale_call_update
AFTER UPDATE ON tedi_call_costs
FOR EACH ROW EXECUTE FUNCTION billing_cost_rollups_stale_call_update_fn();

CREATE FUNCTION billing_cost_rollups_stale_call_delete_fn() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
	UPDATE billing_cost_rollups SET stale = true
	WHERE organization_id = OLD."org_id" AND day = substr(OLD."snapshot_at", 1, 10) AND stale = false;
	RETURN NULL;
END;
$function$;

CREATE TRIGGER billing_cost_rollups_stale_call_delete
AFTER DELETE ON tedi_call_costs
FOR EACH ROW WHEN (OLD."org_id" IS NOT NULL)
EXECUTE FUNCTION billing_cost_rollups_stale_call_delete_fn();

CREATE FUNCTION billing_cost_rollups_stale_cost_evidence_fn() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
	UPDATE billing_cost_rollups SET stale = true
	WHERE organization_id = NEW."original_org_id"
	AND day = substr(NEW."original_source_snapshot" ->> 'snapshotAt', 1, 10) AND stale = false;
	RETURN NULL;
END;
$function$;

CREATE TRIGGER billing_cost_rollups_stale_cost_evidence
AFTER INSERT ON billing_provider_cost_evidence_versions
FOR EACH ROW EXECUTE FUNCTION billing_cost_rollups_stale_cost_evidence_fn();

CREATE UNIQUE INDEX uniq_billing_provider_usage_gateway_log
	ON billing_provider_usage (gateway_log_id) WHERE gateway_log_id IS NOT NULL;

CREATE UNIQUE INDEX uniq_billing_provider_usage_provider_id
	ON billing_provider_usage (provider_usage_id) WHERE provider_usage_id IS NOT NULL;

CREATE INDEX idx_call_costs_provider_units_queue
	ON tedi_call_costs (snapshot_at, gateway_log_id) WHERE usage_kind IS NOT NULL;

END

$install$;
