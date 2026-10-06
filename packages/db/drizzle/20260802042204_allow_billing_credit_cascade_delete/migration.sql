DROP TRIGGER billing_credit_entries_immutable_delete;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_immutable_delete
BEFORE DELETE ON billing_credit_entries
WHEN EXISTS (
	SELECT 1
	FROM organizations
	WHERE id = OLD.organization_id
)
BEGIN
	SELECT RAISE(ABORT, 'billing credit journal is immutable');
END;
