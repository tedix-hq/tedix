-- Retention deletes remain permitted; historical observations cannot be rewritten.
CREATE TRIGGER decision_exposures_no_update BEFORE UPDATE ON decision_exposures
BEGIN SELECT RAISE(ABORT, 'Decision exposures are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER decision_outcome_labels_no_update BEFORE UPDATE ON decision_outcome_labels
BEGIN SELECT RAISE(ABORT, 'Decision outcome labels are append-only'); END;
