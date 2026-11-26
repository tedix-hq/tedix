-- The 20261126071201_unknown_cost_basis_default table rebuild dropped
-- tedi_call_costs and silently removed the billing_cost_rollups staleness
-- triggers below. Recreate them verbatim so rollup invalidation keeps working.
CREATE TRIGGER billing_cost_rollups_stale_call_insert AFTER INSERT ON tedi_call_costs
WHEN NEW.org_id IS NOT NULL
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = NEW.org_id AND day = substr(NEW.snapshot_at, 1, 10) AND stale = 0;
END;
--> statement-breakpoint
CREATE TRIGGER billing_cost_rollups_stale_call_update AFTER UPDATE ON tedi_call_costs
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = OLD.org_id AND day = substr(OLD.snapshot_at, 1, 10) AND stale = 0;
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = NEW.org_id AND day = substr(NEW.snapshot_at, 1, 10) AND stale = 0;
END;
--> statement-breakpoint
CREATE TRIGGER billing_cost_rollups_stale_call_delete AFTER DELETE ON tedi_call_costs
WHEN OLD.org_id IS NOT NULL
BEGIN
 UPDATE billing_cost_rollups SET stale = 1
 WHERE organization_id = OLD.org_id AND day = substr(OLD.snapshot_at, 1, 10) AND stale = 0;
END;
