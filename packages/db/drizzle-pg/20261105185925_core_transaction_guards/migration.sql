CREATE FUNCTION billing_credit_entry_apply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE billing_accounts
	SET credit_balance_micros = credit_balance_micros + NEW.amount_micros,
		updated_at = NEW.created_at
	WHERE organization_id = NEW.organization_id
		AND credit_balance_micros + NEW.amount_micros >= 0;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'billing credit account missing or balance insufficient';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_apply_insert
BEFORE INSERT ON billing_credit_entries
FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_apply();--> statement-breakpoint
CREATE FUNCTION billing_credit_entry_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'billing credit entries are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_immutable_update
BEFORE UPDATE ON billing_credit_entries
FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_immutable();--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_immutable_delete
BEFORE DELETE ON billing_credit_entries
FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_immutable();--> statement-breakpoint
CREATE FUNCTION work_attempt_admission_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM work_admissions admission
		JOIN work_items item
			ON item.org_id = admission.org_id
			AND item.id = admission.work_item_id
		WHERE admission.id = NEW.admission_id
			AND admission.org_id = NEW.org_id
			AND admission.work_item_id = NEW.work_item_id
			AND admission.decision = 'admitted'
			AND admission.expires_at = NEW.expires_at
			AND admission.expires_at > NEW.started_at
			AND admission.executor_type = NEW.executor_type
			AND admission.executor_id = NEW.executor_id
			AND admission.executor_session_id IS NOT DISTINCT FROM NEW.executor_session_id
			AND admission.external_session_key IS NOT DISTINCT FROM NEW.external_session_key
			AND item.version = admission.work_item_version
			AND item.admission_spec_revision = admission.admission_spec_revision
			AND item.disposition = 'accepted'
	) THEN
		RAISE EXCEPTION 'attempt does not match active admission';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER work_attempt_admission_insert_guard
BEFORE INSERT ON work_attempts
FOR EACH ROW EXECUTE FUNCTION work_attempt_admission_guard();--> statement-breakpoint
CREATE FUNCTION work_attempt_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.admission_id IS DISTINCT FROM OLD.admission_id
		OR NEW.org_id IS DISTINCT FROM OLD.org_id
		OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
		OR NEW.executor_type IS DISTINCT FROM OLD.executor_type
		OR NEW.executor_id IS DISTINCT FROM OLD.executor_id
		OR NEW.executor_session_id IS DISTINCT FROM OLD.executor_session_id
		OR NEW.external_session_key IS DISTINCT FROM OLD.external_session_key
		OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
		OR NEW.started_at IS DISTINCT FROM OLD.started_at
		OR NEW.version <> OLD.version + 1
		OR OLD.runtime_state NOT IN ('queued', 'running', 'waiting', 'retrying') THEN
		RAISE EXCEPTION 'attempt fence or terminal state is immutable';
	END IF;
	IF NEW.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
		AND NEW.expires_at IS NULL THEN
		RAISE EXCEPTION 'active attempt requires bounded expiry';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER work_attempt_admission_update_guard
BEFORE UPDATE ON work_attempts
FOR EACH ROW EXECUTE FUNCTION work_attempt_update_guard();--> statement-breakpoint
CREATE FUNCTION work_admission_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'work admissions are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER work_admission_immutable_update
BEFORE UPDATE ON work_admissions
FOR EACH ROW EXECUTE FUNCTION work_admission_immutable();--> statement-breakpoint
CREATE TRIGGER work_admission_immutable_delete
BEFORE DELETE ON work_admissions
FOR EACH ROW EXECUTE FUNCTION work_admission_immutable();
