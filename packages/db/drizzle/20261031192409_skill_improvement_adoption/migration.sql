ALTER TABLE `skill_entries` ADD `improvement_adoption` text;
--> statement-breakpoint
-- Recover only explicitly adopted improvement copies of the same tenant's skill.
-- Older rows without a recoverable run keep that fact unknown.
WITH adoption_markers AS (
 SELECT p.id, p.updated_at,
  substr(p.revision_reasoning, instr(p.revision_reasoning,
   'Activated into canonical skill ' || p.source_skill_id || ' revision ') +
   length('Activated into canonical skill ' || p.source_skill_id || ' revision ')) AS revision_tail,
  CASE WHEN instr(c.revision_reasoning, 'Workflow improvement ' || p.id || ' activated by ') > 0
   THEN substr(c.revision_reasoning, instr(c.revision_reasoning, 'Workflow improvement ' || p.id || ' activated by ')) END AS activation_tail
 FROM skill_entries p JOIN skill_entries c
  ON c.id = p.source_skill_id AND c.organization_id = p.organization_id
 WHERE p.lifecycle_state = 'archived' AND p.improvement_adoption IS NULL
  AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value = 'workflow-improvement')
  AND instr(p.revision_reasoning, 'Activated into canonical skill ' || p.source_skill_id || ' revision ') > 0
), revisions AS (
 SELECT *, substr(revision_tail, 1, instr(revision_tail, '.') - 1) AS revision_text,
  CASE WHEN instr(activation_tail, ' after certified run ') > 0
   THEN substr(activation_tail, instr(activation_tail, ' after certified run ') + length(' after certified run ')) END AS run_tail
 FROM adoption_markers
), adoption AS (
 SELECT *, CASE WHEN instr(run_tail, ': ') > 0 THEN substr(run_tail, 1, instr(run_tail, ': ') - 1) END AS run_id,
  CASE WHEN instr(run_tail, ': ') > 0 THEN trim(substr(run_tail, instr(run_tail, ': ') + 2), char(10)) END AS reason_tail
 FROM revisions
 WHERE revision_text <> '' AND revision_text NOT GLOB '*[^0-9]*' AND cast(revision_text AS integer) > 0
)
UPDATE skill_entries SET improvement_adoption = (
 SELECT json_object(
  'activatedIntoRevision', cast(a.revision_text AS integer),
  'certificationRunId', (SELECT r.id FROM skill_runs r WHERE r.id = a.run_id AND r.skill_id = a.id AND r.organization_id = skill_entries.organization_id),
  'adoptedAt', a.updated_at,
  'reason', CASE WHEN instr(a.reason_tail, char(10)) > 0 THEN substr(a.reason_tail, 1, instr(a.reason_tail, char(10)) - 1) ELSE a.reason_tail END
 ) FROM adoption a WHERE a.id = skill_entries.id
) WHERE id IN (SELECT id FROM adoption);
