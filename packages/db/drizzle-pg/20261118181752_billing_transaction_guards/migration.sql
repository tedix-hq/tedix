-- Apply a journal balance only after the unique row was inserted: BEFORE
-- triggers also run for ON CONFLICT DO NOTHING and would replay the balance.
DROP TRIGGER billing_credit_entries_apply_insert ON billing_credit_entries;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_apply_insert
AFTER INSERT ON billing_credit_entries
FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_apply();
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_immutable_update BEFORE UPDATE ON billing_service_credit_entries FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_immutable();
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_immutable_delete BEFORE DELETE ON billing_service_credit_entries FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_immutable();
