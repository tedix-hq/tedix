ALTER TABLE `work_events` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `work_events` ADD `objective_id` text;--> statement-breakpoint
-- Scope follows the current Work Item, matching the feed's previous join semantics.
UPDATE work_events
SET (project_id, objective_id) = (
  SELECT project_id, objective_id FROM work_items
  WHERE work_items.org_id = work_events.org_id AND work_items.id = work_events.work_item_id
);
--> statement-breakpoint
CREATE TRIGGER work_events_scope_insert AFTER INSERT ON work_events
BEGIN
  UPDATE work_events
  SET (project_id, objective_id) = (
    SELECT project_id, objective_id FROM work_items
    WHERE org_id = NEW.org_id AND id = NEW.work_item_id
  ) WHERE sequence = NEW.sequence;
END;
--> statement-breakpoint
CREATE TRIGGER work_events_scope_update
AFTER UPDATE OF org_id, work_item_id, project_id, objective_id ON work_events
WHEN (NEW.project_id, NEW.objective_id) IS NOT (
  SELECT project_id, objective_id FROM work_items
  WHERE org_id = NEW.org_id AND id = NEW.work_item_id
)
BEGIN
  UPDATE work_events
  SET (project_id, objective_id) = (
    SELECT project_id, objective_id FROM work_items
    WHERE org_id = NEW.org_id AND id = NEW.work_item_id
  ) WHERE sequence = NEW.sequence;
END;
--> statement-breakpoint
CREATE TRIGGER work_items_event_scope_update
AFTER UPDATE OF project_id, objective_id ON work_items
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.objective_id IS NOT OLD.objective_id
BEGIN
  UPDATE work_events SET project_id = NEW.project_id, objective_id = NEW.objective_id
  WHERE org_id = NEW.org_id AND work_item_id = NEW.id;
END;
--> statement-breakpoint
CREATE INDEX `idx_work_events_project_occurred` ON `work_events` (`org_id`,`project_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_events_objective_occurred` ON `work_events` (`org_id`,`objective_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_events_project_sequence` ON `work_events` (`org_id`,`project_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_work_events_objective_sequence` ON `work_events` (`org_id`,`objective_id`,`sequence`);
