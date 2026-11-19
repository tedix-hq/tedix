ALTER TABLE `os_workspace_collaborators` ADD `principal_kind` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
WITH linked AS (
 SELECT DISTINCT w.id AS workspace_id, w.organization_id, t.id AS tedi_id,
  coalesce(t.display_name, t.name) AS name,
  CASE WHEN w.visibility = 'private' THEN w.owner_user_id ELSE (
   SELECT m.descope_user_id FROM organization_members m
   WHERE m.organization_id = w.organization_id AND m.kind = 'human' AND m.status = 'active'
    AND m.role IN ('owner', 'admin', 'member')
   ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.descope_user_id LIMIT 1
  ) END AS sharer_id
 FROM os_workspace_resources r
 JOIN os_workspaces w ON w.id = r.workspace_id AND w.organization_id = r.organization_id
 JOIN skill_entries s ON s.id = r.provider_resource_id AND s.organization_id = r.organization_id
 JOIN tedis t ON t.id = s.tedi_id AND t.organization_id = r.organization_id
 WHERE r.provider_id = 'tedix' AND r.resource_type = 'skill' AND r.status = 'active'
  AND w.status = 'active' AND t.status = 'active'
)
INSERT INTO os_workspace_collaborators (id, organization_id, workspace_id, user_id, principal_kind, name)
SELECT 'skill-tedi:' || workspace_id || ':' || tedi_id, organization_id, workspace_id, tedi_id, 'tedi', name
FROM linked WHERE sharer_id IS NOT NULL
ON CONFLICT(workspace_id, user_id) DO NOTHING;
--> statement-breakpoint
WITH linked AS (
 SELECT DISTINCT w.id AS workspace_id, w.organization_id, t.id AS tedi_id,
  CASE WHEN w.visibility = 'private' THEN w.owner_user_id ELSE (
   SELECT m.descope_user_id FROM organization_members m
   WHERE m.organization_id = w.organization_id AND m.kind = 'human' AND m.status = 'active'
    AND m.role IN ('owner', 'admin', 'member')
   ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.descope_user_id LIMIT 1
  ) END AS sharer_id
 FROM os_workspace_resources r
 JOIN os_workspaces w ON w.id = r.workspace_id AND w.organization_id = r.organization_id
 JOIN skill_entries s ON s.id = r.provider_resource_id AND s.organization_id = r.organization_id
 JOIN tedis t ON t.id = s.tedi_id AND t.organization_id = r.organization_id
 WHERE r.provider_id = 'tedix' AND r.resource_type = 'skill' AND r.status = 'active'
  AND w.status = 'active' AND t.status = 'active'
)
INSERT INTO os_workspace_access_edges (id, organization_id, workspace_id, target_user_id, kind, edge_key, sharer_user_id, role, note)
SELECT 'skill-tedi:' || workspace_id || ':' || tedi_id, organization_id, workspace_id, tedi_id,
 'tedi', 'user:' || sharer_id, sharer_id, 'build', 'Linked skill executor'
FROM linked WHERE sharer_id IS NOT NULL
ON CONFLICT(workspace_id, target_user_id, edge_key) DO NOTHING;
