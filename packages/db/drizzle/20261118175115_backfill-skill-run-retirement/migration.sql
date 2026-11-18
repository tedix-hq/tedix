-- Preserve the permanent execution fence even if revocation removes artifacts.
UPDATE skill_runs AS r
SET workflow_retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE r.workflow_retired_at IS NULL
  AND (
    r.error = 'REVOKED'
    OR r.error GLOB 'REVOKED:*'
    OR EXISTS (
      SELECT 1 FROM skill_run_artifacts AS a
      WHERE a.run_id = r.id
        AND a.path LIKE 'controls/restarts/%'
        AND CASE WHEN json_valid(a.content_inline)
          THEN json_extract(a.content_inline, '$.status') END = 'rejected'
        AND CASE WHEN json_valid(a.content_inline)
          THEN json_extract(a.content_inline, '$.resolution.action') END = 'operator_abort'
    )
  );
