-- Wrangler applies this whole migration transactionally. The CHECK refuses
-- the swap while any captured source rowid remains unvisited. Mirrored writes
-- include the tail, so there is no unbounded final copy or application pause.
UPDATE audit_events_rebuild SET complete = 1 WHERE id = 1;
DROP TRIGGER audit_events_rebuild_insert;
DROP TRIGGER audit_events_rebuild_update;
DROP TRIGGER audit_events_rebuild_delete;
DROP TRIGGER audit_events_rebuild_copy;
-- Keep the retired copy until bounded cleanup, avoiding a large DROP.
ALTER TABLE audit_events RENAME TO audit_events_pre_lookup;
ALTER TABLE audit_events_v2 RENAME TO audit_events;
DROP TABLE audit_events_rebuild;
