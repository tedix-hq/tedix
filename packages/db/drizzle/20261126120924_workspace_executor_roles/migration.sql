-- Preserve configured executors before requiring their graph role on every workspace call.
WITH resource_candidates (organization_id, workspace_id, tedi_id) AS MATERIALIZED (
 SELECT r.organization_id, r.workspace_id, s.tedi_id
 FROM os_workspace_resources r JOIN skill_entries s
  ON s.organization_id = r.organization_id AND s.id = r.provider_resource_id
 WHERE r.provider_id = 'tedix' AND r.resource_type = 'skill' AND r.status = 'active'
 UNION
 SELECT organization_id, workspace_id, provider_resource_id FROM os_workspace_resources
 WHERE provider_id = 'tedix' AND resource_type = 'tedi' AND status = 'active'
), candidates (organization_id, workspace_id, tedi_id) AS (
 SELECT * FROM resource_candidates
 UNION
 SELECT organization_id, id, default_tedi_id FROM os_workspaces WHERE default_tedi_id IS NOT NULL
 UNION
 SELECT organization_id, workspace_id, json_extract(configuration, '$.tediId') FROM calendar_coordinator_configurations
 WHERE json_valid(configuration)
 UNION
 SELECT organization_id, json_extract(params, '$.workspaceId'), tedi_id FROM skill_schedules
 WHERE json_valid(params)
 UNION
 SELECT p.org_id, json_extract(p.metadata, '$.factory.workspaceId'), s.tedi_id
 FROM projects p JOIN skill_entries s
  ON s.organization_id = p.org_id AND s.id = json_extract(p.metadata, '$.factory.skillId')
 WHERE json_valid(p.metadata)
), eligible AS (
 SELECT DISTINCT w.organization_id, w.id AS workspace_id, t.id AS tedi_id,
  coalesce(t.display_name, t.name) AS name,
  CASE WHEN w.visibility = 'private' THEN w.owner_user_id ELSE (
   SELECT m.descope_user_id FROM organization_members m
   WHERE m.organization_id = w.organization_id AND m.kind = 'human' AND m.status = 'active'
    AND m.role IN ('owner', 'admin', 'member')
   ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.descope_user_id LIMIT 1
  ) END AS sharer_id
 FROM candidates c
 JOIN os_workspaces w ON w.id = c.workspace_id AND w.organization_id = c.organization_id
 JOIN tedis t ON t.id = c.tedi_id AND t.organization_id = c.organization_id
 WHERE w.status = 'active' AND t.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM os_workspace_access_edges e WHERE e.workspace_id = w.id AND e.target_user_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM os_workspace_collaborators x WHERE x.workspace_id = w.id AND x.user_id = t.id
   AND x.id <> 'executor-tedi:' || w.id || ':' || t.id)
)
INSERT INTO os_workspace_collaborators (id, organization_id, workspace_id, user_id, principal_kind, name)
SELECT 'executor-tedi:' || workspace_id || ':' || tedi_id, organization_id, workspace_id, tedi_id, 'tedi', name
FROM eligible WHERE sharer_id IS NOT NULL
ON CONFLICT(workspace_id, user_id) DO NOTHING;
--> statement-breakpoint
WITH resource_candidates (organization_id, workspace_id, tedi_id) AS MATERIALIZED (
 SELECT r.organization_id, r.workspace_id, s.tedi_id
 FROM os_workspace_resources r JOIN skill_entries s
  ON s.organization_id = r.organization_id AND s.id = r.provider_resource_id
 WHERE r.provider_id = 'tedix' AND r.resource_type = 'skill' AND r.status = 'active'
 UNION
 SELECT organization_id, workspace_id, provider_resource_id FROM os_workspace_resources
 WHERE provider_id = 'tedix' AND resource_type = 'tedi' AND status = 'active'
), candidates (organization_id, workspace_id, tedi_id) AS (
 SELECT * FROM resource_candidates
 UNION
 SELECT organization_id, id, default_tedi_id FROM os_workspaces WHERE default_tedi_id IS NOT NULL
 UNION
 SELECT organization_id, workspace_id, json_extract(configuration, '$.tediId') FROM calendar_coordinator_configurations
 WHERE json_valid(configuration)
 UNION
 SELECT organization_id, json_extract(params, '$.workspaceId'), tedi_id FROM skill_schedules
 WHERE json_valid(params)
 UNION
 SELECT p.org_id, json_extract(p.metadata, '$.factory.workspaceId'), s.tedi_id
 FROM projects p JOIN skill_entries s
  ON s.organization_id = p.org_id AND s.id = json_extract(p.metadata, '$.factory.skillId')
 WHERE json_valid(p.metadata)
), eligible AS (
 SELECT DISTINCT w.organization_id, w.id AS workspace_id, t.id AS tedi_id,
  coalesce(t.display_name, t.name) AS name,
  CASE WHEN w.visibility = 'private' THEN w.owner_user_id ELSE (
   SELECT m.descope_user_id FROM organization_members m
   WHERE m.organization_id = w.organization_id AND m.kind = 'human' AND m.status = 'active'
    AND m.role IN ('owner', 'admin', 'member')
   ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.descope_user_id LIMIT 1
  ) END AS sharer_id
 FROM candidates c
 JOIN os_workspaces w ON w.id = c.workspace_id AND w.organization_id = c.organization_id
 JOIN tedis t ON t.id = c.tedi_id AND t.organization_id = c.organization_id
 WHERE w.status = 'active' AND t.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM os_workspace_access_edges e WHERE e.workspace_id = w.id AND e.target_user_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM os_workspace_collaborators x WHERE x.workspace_id = w.id AND x.user_id = t.id
   AND x.id <> 'executor-tedi:' || w.id || ':' || t.id)
)
INSERT INTO os_workspace_access_edges (id, organization_id, workspace_id, target_user_id, kind, edge_key, sharer_user_id, role, note)
SELECT 'executor-tedi:' || workspace_id || ':' || tedi_id, organization_id, workspace_id, tedi_id,
 'tedi', 'user:' || sharer_id, sharer_id, 'build', 'Configured workspace executor'
FROM eligible WHERE sharer_id IS NOT NULL
ON CONFLICT(workspace_id, target_user_id, edge_key) DO NOTHING;
