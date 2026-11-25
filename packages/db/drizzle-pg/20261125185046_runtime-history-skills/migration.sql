BEGIN;
LOCK TABLE skill_runs IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX idx_skill_runs_reconcile_pending
ON skill_runs(runtime_environment, coalesce(last_reconciled_at, started_at), started_at)
WHERE workflow_retired_at IS NULL AND (
 status IN ('queued', 'running', 'paused') OR restart_requested_at IS NOT NULL OR
 (status = 'failed' AND (
  translate(error, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE 'workflow_admission_create_failed:%' ESCAPE '' OR
  translate(error, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE 'workflow_admission_pending:%' ESCAPE ''
 ))
);

CREATE FUNCTION skill_run_commitment_wake() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE key text;
BEGIN
 IF NEW.status NOT IN ('failed', 'completed') OR NEW.completed_at IS NULL
  OR (NEW.work_item_id IS NULL AND NEW.origin_tedi_run_id IS NULL)
  OR NOT pg_input_is_valid(NEW.completed_at, 'timestamp with time zone') THEN
  RETURN NULL;
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
  AND NEW.status IS NOT DISTINCT FROM OLD.status
  AND NEW.execution_epoch IS NOT DISTINCT FROM OLD.execution_epoch THEN
  RETURN NULL;
 END IF;
 key := 'skill:' || NEW.id || ':' || NEW.execution_epoch || ':' || NEW.status;
 INSERT INTO commitment_wake_outbox
  (id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
 VALUES ('skill:' || NEW.id || ':' || NEW.completed_at || ':' || key,
  'commitment_wake', NEW.organization_id, 'skill', NEW.id, NEW.completed_at,
  to_char((NEW.completed_at::timestamptz + interval '30 seconds') AT TIME ZONE 'UTC',
   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), key)
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$$;

CREATE TRIGGER commitment_wake_outbox_skill
AFTER INSERT OR UPDATE ON skill_runs FOR EACH ROW
EXECUTE FUNCTION skill_run_commitment_wake();

INSERT INTO commitment_wake_outbox
 (id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
SELECT 'skill:' || id || ':' || completed_at || ':skill:' || id || ':' || execution_epoch || ':' || status,
 'commitment_wake', organization_id, 'skill', id, completed_at,
 to_char((completed_at::timestamptz + interval '30 seconds') AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'skill:' || id || ':' || execution_epoch || ':' || status
FROM skill_runs
WHERE status IN ('failed', 'completed') AND completed_at IS NOT NULL
 AND (work_item_id IS NOT NULL OR origin_tedi_run_id IS NOT NULL)
 AND pg_input_is_valid(completed_at, 'timestamp with time zone')
ON CONFLICT DO NOTHING;
COMMIT;
