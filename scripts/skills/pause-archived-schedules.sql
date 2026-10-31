-- One-time managed-ops repair. Run both statements in the same D1 execution.
UPDATE skill_schedules
SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE enabled = 1
  AND EXISTS (
    SELECT 1 FROM skill_entries
    WHERE skill_entries.id = skill_schedules.skill_id
      AND skill_entries.organization_id = skill_schedules.organization_id
      AND skill_entries.lifecycle_state = 'archived'
  );
SELECT changes() AS paused_count;
