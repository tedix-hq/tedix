-- After 0007 only. At most 1,000 retired rows per request.
DELETE FROM audit_events_pre_lookup WHERE rowid IN (SELECT rowid FROM audit_events_pre_lookup LIMIT 1000);
SELECT NOT EXISTS (SELECT 1 FROM audit_events_pre_lookup LIMIT 1) AS done;
