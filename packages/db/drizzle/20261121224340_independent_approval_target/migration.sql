-- Rollback: DROP TRIGGER work_interaction_delegate_creator_guard.
CREATE TRIGGER `work_interaction_delegate_creator_guard` BEFORE UPDATE ON `work_interactions`
WHEN (NEW.target_type IS NOT OLD.target_type OR NEW.target_id IS NOT OLD.target_id)
 AND NEW.target_type IN ('tedi','external_agent')
 AND NEW.target_id = OLD.creator_id
BEGIN
 SELECT RAISE(ABORT,'The card creator cannot be its delegate');
END;
