BEGIN;
LOCK TABLE tedi_runtime_events IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION tedi_runtime_mark_terminal_seen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.run_id IS NULL THEN RETURN NULL; END IF;
 IF NEW.kind = 'run.started' THEN
  UPDATE tedi_runtime_events SET terminal_seen = 1
  WHERE id = NEW.id AND terminal_seen = 0 AND EXISTS (
   SELECT 1 FROM tedi_runtime_events terminal
   WHERE terminal.organization_id = NEW.organization_id
    AND terminal.tedi_id = NEW.tedi_id AND terminal.run_id = NEW.run_id
    AND terminal.kind IN ('run.completed', 'run.failed', 'run.canceled')
  );
 ELSIF NEW.kind IN ('run.completed', 'run.failed', 'run.canceled') THEN
  UPDATE tedi_runtime_events SET terminal_seen = 1
  WHERE organization_id = NEW.organization_id AND tedi_id = NEW.tedi_id
   AND run_id = NEW.run_id AND kind = 'run.started' AND terminal_seen = 0;
 END IF;
 RETURN NULL;
END;
$$;

CREATE TRIGGER tedi_runtime_terminal_seen
AFTER INSERT ON tedi_runtime_events FOR EACH ROW
EXECUTE FUNCTION tedi_runtime_mark_terminal_seen();

CREATE FUNCTION runtime_event_orphan_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  DELETE FROM work_due
  WHERE org_id = OLD.organization_id AND kind = 'orphan-run-sweep' AND object_id = OLD.id;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  DELETE FROM work_due
  WHERE org_id = NEW.organization_id AND kind = 'orphan-run-sweep' AND object_id = NEW.id;
  INSERT INTO work_due(org_id, kind, object_id, due_at, status, lease_until)
  SELECT organization_id, 'orphan-run-sweep', id,
   to_char((created_at::timestamptz + interval '12 minutes') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'pending', ''
  FROM tedi_runtime_events
  WHERE id = NEW.id AND kind = 'run.started' AND terminal_seen = 0 AND run_id IS NOT NULL
   AND pg_input_is_valid(created_at, 'timestamp with time zone')
  ON CONFLICT(org_id, kind, object_id) DO UPDATE
   SET due_at = excluded.due_at, status = 'pending', lease_until = '';
 END IF;
 RETURN NULL;
END;
$$;

CREATE TRIGGER work_due_orphan_run_sweep
AFTER INSERT OR UPDATE OR DELETE ON tedi_runtime_events FOR EACH ROW
EXECUTE FUNCTION runtime_event_orphan_due();

UPDATE tedi_runtime_events started SET terminal_seen = 1
WHERE started.kind = 'run.started' AND started.run_id IS NOT NULL AND started.terminal_seen = 0
 AND EXISTS (
  SELECT 1 FROM tedi_runtime_events terminal
  WHERE terminal.organization_id = started.organization_id
   AND terminal.tedi_id = started.tedi_id AND terminal.run_id = started.run_id
   AND terminal.kind IN ('run.completed', 'run.failed', 'run.canceled')
 );

DELETE FROM work_due WHERE kind = 'orphan-run-sweep';
INSERT INTO work_due(org_id, kind, object_id, due_at, status, lease_until)
SELECT organization_id, 'orphan-run-sweep', id,
 to_char((created_at::timestamptz + interval '12 minutes') AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'pending', ''
FROM tedi_runtime_events
WHERE kind = 'run.started' AND terminal_seen = 0 AND run_id IS NOT NULL
 AND pg_input_is_valid(created_at, 'timestamp with time zone');
COMMIT;
