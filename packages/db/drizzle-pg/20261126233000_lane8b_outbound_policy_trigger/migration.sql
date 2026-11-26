BEGIN;
LOCK TABLE organizations, work_items, work_events, work_due IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION work_due_outbound_policy_update_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM work_due WHERE org_id = NEW.id AND kind = 'outbound-review';
 INSERT INTO work_due (org_id, kind, object_id, due_at, status, lease_until)
 SELECT w.org_id, 'outbound-review', w.id, t.due_at, 'pending', ''
 FROM work_items w
 JOIN organizations o ON o.id = w.org_id
 CROSS JOIN LATERAL (
  SELECT
   coalesce(
    w.metadata #>> '{outbound,reviewRequestedAt}',
    (SELECT max(e.occurred_at) FROM work_events e
      WHERE e.org_id = w.org_id AND e.work_item_id = w.id
        AND e.event_type = 'outbound.action'),
    w.updated_at,
    w.created_at
   ) AS requested_at,
   CASE
    WHEN pg_input_is_valid(o.metadata #>> '{outboundReview,reviewTimeoutMinutes}', 'numeric')
    THEN (o.metadata #>> '{outboundReview,reviewTimeoutMinutes}')::numeric
    ELSE 30
   END AS timeout_minutes
 ) base
 CROSS JOIN LATERAL (
  SELECT CASE
   WHEN pg_input_is_valid(base.requested_at, 'timestamp with time zone')
   THEN to_char(((base.requested_at)::timestamptz + base.timeout_minutes * interval '1 minute')
     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   ELSE NULL
  END AS due_at
 ) t
 WHERE w.org_id = NEW.id
  AND w.work_kind = 'outbound'
  AND w.disposition NOT IN ('completed', 'cancelled')
  AND w.metadata #>> '{outbound,status}' IN ('reviewing', 'feedback')
  AND t.due_at IS NOT NULL
 ON CONFLICT (org_id, kind, object_id)
 DO UPDATE SET due_at = excluded.due_at, status = 'pending', lease_until = '';
 RETURN NULL;
END;
$$;

CREATE TRIGGER work_due_outbound_policy_update
AFTER UPDATE OF metadata ON organizations
FOR EACH ROW
EXECUTE FUNCTION work_due_outbound_policy_update_fn();

INSERT INTO work_due (org_id, kind, object_id, due_at, status, lease_until)
SELECT w.org_id, 'outbound-review', w.id, t.due_at, 'pending', ''
FROM work_items w
JOIN organizations o ON o.id = w.org_id
CROSS JOIN LATERAL (
 SELECT
  coalesce(
   w.metadata #>> '{outbound,reviewRequestedAt}',
   (SELECT max(e.occurred_at) FROM work_events e
     WHERE e.org_id = w.org_id AND e.work_item_id = w.id
       AND e.event_type = 'outbound.action'),
   w.updated_at,
   w.created_at
  ) AS requested_at,
  CASE
   WHEN pg_input_is_valid(o.metadata #>> '{outboundReview,reviewTimeoutMinutes}', 'numeric')
   THEN (o.metadata #>> '{outboundReview,reviewTimeoutMinutes}')::numeric
   ELSE 30
  END AS timeout_minutes
) base
CROSS JOIN LATERAL (
 SELECT CASE
  WHEN pg_input_is_valid(base.requested_at, 'timestamp with time zone')
  THEN to_char(((base.requested_at)::timestamptz + base.timeout_minutes * interval '1 minute')
    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ELSE NULL
 END AS due_at
) t
WHERE w.work_kind = 'outbound'
 AND w.disposition NOT IN ('completed', 'cancelled')
 AND w.metadata #>> '{outbound,status}' IN ('reviewing', 'feedback')
 AND t.due_at IS NOT NULL
ON CONFLICT (org_id, kind, object_id)
DO UPDATE SET due_at = excluded.due_at, status = 'pending', lease_until = '';

COMMIT;
