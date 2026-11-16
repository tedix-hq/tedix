-- Shared runtime-event row shape; recovery is served from main D1.
ALTER TABLE tedi_runtime_events ADD terminal_seen integer DEFAULT 0 NOT NULL;
CREATE INDEX idx_tedi_runtime_events_unfinished ON tedi_runtime_events (terminal_seen,kind,created_at);
CREATE INDEX idx_tedi_runtime_events_org_unfinished ON tedi_runtime_events (organization_id,terminal_seen,kind,created_at);
