-- Refuse a populated-table DROP. Drain the retired copy in bounded statements
-- after 0007; the active audit_events table continues receiving writes.
CREATE TABLE audit_events_cleanup_guard (empty INTEGER NOT NULL CHECK (empty = 1));
INSERT INTO audit_events_cleanup_guard SELECT NOT EXISTS (SELECT 1 FROM audit_events_pre_lookup LIMIT 1);
DROP TABLE audit_events_pre_lookup;
DROP TABLE audit_events_cleanup_guard;
