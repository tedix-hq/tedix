-- Pin unassigned tedis to the same published heads used by the resolver.
-- Explicit assignments, including older revisions, remain unchanged.
-- tedix: destructive-reviewed Work-Item: e478b3df-1a82-4524-9524-560eb159ee50
-- Preservation plan: the only dropped table is the guard created below.
-- It has no incoming foreign keys and holds only this migration's boolean.
-- No pre-existing table, customer row, or channel content is deleted.
CREATE TABLE `_tedi_control_plane_backfill_guard` (
    `ready` INTEGER NOT NULL CHECK (`ready` = 1)
);
--> statement-breakpoint
INSERT INTO `_tedi_control_plane_backfill_guard` (`ready`)
SELECT CASE WHEN
    (NOT EXISTS (SELECT 1 FROM tedis WHERE runtime_profile_id IS NULL) OR
        EXISTS (SELECT 1 FROM runtime_profiles WHERE scope = 'system'
            AND slug = 'system-default' AND status = 'active' AND published_at IS NOT NULL))
    AND (NOT EXISTS (SELECT 1 FROM tedis WHERE policy_pack_id IS NULL) OR
        EXISTS (SELECT 1 FROM policy_packs WHERE scope = 'system'
            AND slug = 'system-default' AND status = 'active' AND published_at IS NOT NULL
            AND target IN ('tedi', 'shared')))
    AND (NOT EXISTS (SELECT 1 FROM tedis WHERE workspace_template_set_id IS NULL) OR
        EXISTS (SELECT 1 FROM workspace_template_sets WHERE scope = 'system'
            AND slug = 'system-default' AND status = 'active' AND published_at IS NOT NULL))
    THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE `_tedi_control_plane_backfill_guard`;
--> statement-breakpoint
UPDATE tedis SET
    runtime_profile_id = COALESCE(runtime_profile_id, (
        SELECT id FROM runtime_profiles WHERE scope = 'system' AND slug = 'system-default'
            AND status = 'active' AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1
    )),
    policy_pack_id = COALESCE(policy_pack_id, (
        SELECT id FROM policy_packs WHERE scope = 'system' AND slug = 'system-default'
            AND status = 'active' AND published_at IS NOT NULL AND target IN ('tedi', 'shared')
            ORDER BY version DESC LIMIT 1
    )),
    workspace_template_set_id = COALESCE(workspace_template_set_id, (
        SELECT id FROM workspace_template_sets WHERE scope = 'system' AND slug = 'system-default'
            AND status = 'active' AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1
    ))
WHERE runtime_profile_id IS NULL OR policy_pack_id IS NULL OR workspace_template_set_id IS NULL;
