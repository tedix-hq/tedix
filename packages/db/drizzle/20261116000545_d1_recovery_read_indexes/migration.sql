ALTER TABLE `tedi_runtime_events` ADD `terminal_seen` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_learning_event_decision_choice` ON `learning_interaction_events` (`surface`,json_extract("metadata", '$.decisionChoice'),`scope_kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_stale_delegation` ON `work_items` (`disposition`,COALESCE("updated_at", "created_at"),`org_id`,`id`) WHERE json_extract("work_items"."provenance", '$.source') = 'kernelRuntime.directDelegation';--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_unfinished` ON `tedi_runtime_events` (`terminal_seen`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_runtime_events_org_unfinished` ON `tedi_runtime_events` (`organization_id`,`terminal_seen`,`kind`,`created_at`);--> statement-breakpoint
-- Runtime events are append-only. Keep the marker after terminal log rotation,
-- so a completed run cannot become an orphan when its terminal row is removed.
CREATE TRIGGER tedi_runtime_start_terminal_seen
AFTER INSERT ON tedi_runtime_events
WHEN NEW.kind = 'run.started' AND NEW.run_id IS NOT NULL
BEGIN
 UPDATE tedi_runtime_events SET terminal_seen = 1
 WHERE id = NEW.id AND EXISTS (
  SELECT 1 FROM tedi_runtime_events terminal INDEXED BY idx_tedi_runtime_events_run_kind_created
  WHERE terminal.organization_id = NEW.organization_id
   AND terminal.tedi_id = NEW.tedi_id AND terminal.run_id = NEW.run_id
   AND terminal.kind IN ('run.completed', 'run.failed', 'run.canceled')
 );
END;--> statement-breakpoint
CREATE TRIGGER tedi_runtime_terminal_seen
AFTER INSERT ON tedi_runtime_events
WHEN NEW.kind IN ('run.completed', 'run.failed', 'run.canceled') AND NEW.run_id IS NOT NULL
BEGIN
 UPDATE tedi_runtime_events SET terminal_seen = 1
 WHERE id IN (
  SELECT started.id FROM tedi_runtime_events started INDEXED BY idx_tedi_runtime_events_run_kind_created
  WHERE started.organization_id = NEW.organization_id
   AND started.tedi_id = NEW.tedi_id AND started.run_id = NEW.run_id
   AND started.kind = 'run.started' AND started.terminal_seen = 0
 );
END;--> statement-breakpoint
UPDATE tedi_runtime_events AS started SET terminal_seen = 1
WHERE started.kind = 'run.started' AND started.run_id IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM tedi_runtime_events terminal INDEXED BY idx_tedi_runtime_events_run_kind_created
  WHERE terminal.organization_id = started.organization_id
   AND terminal.tedi_id = started.tedi_id AND terminal.run_id = started.run_id
   AND terminal.kind IN ('run.completed', 'run.failed', 'run.canceled')
 );
