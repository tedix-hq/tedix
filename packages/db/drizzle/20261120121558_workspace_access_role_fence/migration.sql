-- Workspace role checks reuse a role while this version holds. Every input
-- of a role advances it: workspaces, access edges, share links and tedis
-- (organization members already do).
CREATE TRIGGER auth_context_cache_os_workspaces_insert
AFTER INSERT ON os_workspaces
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspaces_update
AFTER UPDATE OF id, organization_id, status, visibility, owner_user_id ON os_workspaces
WHEN NEW.id IS NOT OLD.id
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.status IS NOT OLD.status
  OR NEW.visibility IS NOT OLD.visibility
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspaces_delete
AFTER DELETE ON os_workspaces
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_insert
AFTER INSERT ON os_workspace_access_edges
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_update
AFTER UPDATE ON os_workspace_access_edges
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_delete
AFTER DELETE ON os_workspace_access_edges
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_insert
AFTER INSERT ON os_workspace_share_links
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_update
AFTER UPDATE ON os_workspace_share_links
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_delete
AFTER DELETE ON os_workspace_share_links
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_insert
AFTER INSERT ON tedis
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_update
AFTER UPDATE OF id, organization_id, status, scope, owner_user_id ON tedis
WHEN NEW.id IS NOT OLD.id
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.status IS NOT OLD.status
  OR NEW.scope IS NOT OLD.scope
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_delete
AFTER DELETE ON tedis
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;
