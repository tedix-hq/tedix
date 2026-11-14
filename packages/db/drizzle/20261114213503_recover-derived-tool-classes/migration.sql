-- Recover the old derived baseline, not an owner declaration. Removing the
-- migration-created declared flag preserves the critical-action name checks.
-- Only unchanged, previously synchronized rows with the exact overwritten
-- policy are eligible. Curated metadata, Notion exceptions, missing provenance,
-- later edits and conflicting pre-migration audit samples stay for review.
WITH migration AS (
	SELECT applied_at FROM tedix_drizzle_migrations
	WHERE name = '20261114160256_require-tool-class/migration.sql'
), prior_audit AS MATERIALIZED (
	SELECT resource_id,
		json_extract(metadata, '$.riskTier') AS tier,
		json_extract(metadata, '$.blastRadius') AS radius
	FROM audit_events, migration
	WHERE timestamp >= unixepoch(applied_at) - 86400
		AND timestamp < unixepoch(applied_at)
		AND json_valid(metadata)
		AND json_extract(metadata, '$.riskTier') IN
			('bounded_write', 'high_impact_write', 'external_side_effect')
), candidates AS (
	SELECT t.id,
		CASE WHEN json_extract(t.config, '$.transport') IN ('external', 'mcp')
			THEN 'external_side_effect'
			WHEN t.write_capability = 'destructive' THEN 'high_impact_write'
			ELSE 'bounded_write' END AS tier,
		CASE WHEN json_extract(t.config, '$.transport') IN ('external', 'mcp')
			THEN 'external_system'
			WHEN t.write_capability = 'destructive' THEN 'tenant'
			ELSE 'single_resource' END AS radius
	FROM app_tools t, migration
	WHERE t.write_capability IN ('write', 'destructive')
		AND datetime(t.updated_at) < datetime(applied_at)
		AND datetime(t.schema_synced_at) < datetime(applied_at)
		AND length(t.schema_source_hash) > 0
		AND json_valid(t.config) AND json_valid(t.meta)
		AND json_valid(t.annotations)
		AND json_extract(t.annotations, '$.readOnlyHint') = 0
		AND t.write_capability = CASE
			WHEN json_extract(t.annotations, '$.destructiveHint') = 1
				THEN 'destructive' ELSE 'write' END
		AND ((t.schema_source = 'orpc' AND json_extract(t.config, '$.transport') = 'rpc')
			OR (t.schema_source = 'openapi' AND json_extract(t.config, '$.transport') = 'external')
			OR (t.schema_source = 'mcp' AND json_extract(t.config, '$.transport') = 'mcp'))
		AND json_extract(t.meta, '$."com.tedix/policy".riskTier') = 'high_impact_write'
		AND json_extract(t.meta, '$."com.tedix/policy".blastRadius') = 'multi_tenant'
		AND json_extract(t.meta, '$."com.tedix/policy".declared') = 1
		AND (SELECT count(*) FROM json_each(t.meta, '$."com.tedix/policy"')) = 3
		-- These routes received a curated bounded class in 20261020203221.
		AND NOT (json_extract(t.config, '$.transport') = 'mcp'
			AND coalesce(json_extract(t.config, '$.mcpToolName'), '') IN
				('notion-update-page', 'notion_update_page', 'notion-create-pages', 'notion_create_pages'))
), reviewed AS (
	SELECT c.* FROM candidates c JOIN app_tools t ON t.id = c.id
	WHERE NOT EXISTS (
		SELECT 1 FROM prior_audit a
		WHERE (a.resource_id = t.tool_id
			OR substr(a.resource_id, -length(t.tool_id) - 1) = '.' || t.tool_id
			OR substr(a.resource_id, -length(t.tool_id) - 2) = '__' || t.tool_id)
			AND (a.tier <> c.tier OR a.radius IS NOT c.radius)
	)
)
UPDATE app_tools SET meta = json_set(
	json_remove(meta, '$."com.tedix/policy".declared'),
	'$."com.tedix/policy".riskTier', (SELECT tier FROM reviewed WHERE reviewed.id = app_tools.id),
	'$."com.tedix/policy".blastRadius', (SELECT radius FROM reviewed WHERE reviewed.id = app_tools.id)
)
WHERE id IN (SELECT id FROM reviewed);
