-- Credit budgets: envelopes in Tedix credits that the organization wallet
-- enforces as Code Mode runs and model calls spend, and objective scopes.
-- USD envelopes keep the per-Attempt reservation model unchanged.
-- Rollback: recreate the trigger from 20260821020828_work_factory_external_session_fences.
DROP TRIGGER IF EXISTS `work_budget_envelope_scope_insert_guard`;--> statement-breakpoint
CREATE TRIGGER `work_budget_envelope_scope_insert_guard` BEFORE INSERT ON `work_budget_envelopes`
BEGIN
	SELECT RAISE(ABORT,'invalid budget envelope initial state') WHERE NEW.`version`<>1 OR NEW.`currency` NOT IN ('USD','credits') OR (NEW.`currency`='credits' AND NEW.`reservation_micros`<>0);
	SELECT RAISE(ABORT,'invalid budget scope') WHERE NOT (
		(NEW.`scope_type`='organization' AND NEW.`scope_id`=NEW.`org_id`) OR
		(NEW.`scope_type`='project' AND EXISTS(SELECT 1 FROM `projects` p WHERE p.`org_id`=NEW.`org_id` AND p.`id`=NEW.`scope_id`)) OR
		(NEW.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=NEW.`org_id` AND c.`id`=NEW.`scope_id`)) OR
		(NEW.`scope_type`='work_item' AND EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`scope_id`)) OR
		(NEW.`scope_type`='objective' AND NEW.`currency`='credits' AND EXISTS(SELECT 1 FROM `tedi_objectives` o WHERE o.`org_id`=NEW.`org_id` AND o.`id`=NEW.`scope_id`))
	);
END;
