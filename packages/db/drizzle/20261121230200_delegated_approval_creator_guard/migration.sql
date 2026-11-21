-- Rollback: recreate the previous unconditional creator guard.
DROP TRIGGER `work_interaction_delegate_creator_guard`;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_delegate_creator_guard` BEFORE UPDATE ON `work_interactions`
WHEN (NEW.target_type IS NOT OLD.target_type OR NEW.target_id IS NOT OLD.target_id)
 AND json_type(NEW.metadata,'$.delegatedApproval') IS NOT NULL
 AND NEW.target_type IN ('tedi','external_agent')
 AND NEW.target_id = OLD.creator_id
BEGIN
 SELECT RAISE(ABORT,'The card creator cannot be its delegate');
END;
