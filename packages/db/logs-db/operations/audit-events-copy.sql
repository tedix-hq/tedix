-- At most 1,000 rowids per request. Safe to resume.
UPDATE audit_events_rebuild SET cursor = MIN(cursor + 1000, stop) WHERE id = 1 AND cursor < stop;
SELECT cursor, stop, cursor = stop AS done FROM audit_events_rebuild WHERE id = 1;
