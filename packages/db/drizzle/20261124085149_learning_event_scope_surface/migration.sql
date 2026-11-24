-- A person's learning events on one surface, newest first. The scope index
-- walked every event of that person (58k rows per call, ~2 s on main D1) to
-- find a rare surface. Index only; no rows change.
-- Rollback: DROP INDEX idx_learning_event_scope_surface_occurred;
CREATE INDEX `idx_learning_event_scope_surface_occurred` ON `learning_interaction_events` (`organization_id`,`scope_kind`,`scope_id`,`surface`,`occurred_at`);
