-- The last turns of one session, newest first. Without this index each Mac
-- session report walked every turn's body (source_at follows body in the row,
-- ~10 KB each) to return three; on 24 Nov 08:13 one such read took ~11 s of D1
-- time in a 10 s window. Building it reads the table's bodies once (estimates
-- range from ~0.23 to ~0.7 GB, so roughly 5-15 s on main D1); ship it at a
-- quiet hour. Index only; no rows change.
-- Rollback: DROP INDEX idx_agent_session_events_session_kind_order;
CREATE INDEX `idx_agent_session_events_session_kind_order` ON `agent_session_events` (`organization_id`,`user_id`,`harness`,`session_key`,`kind`,`source_at`,`source_key`);
