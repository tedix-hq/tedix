-- Work cancellation preserves history. Correct the inferred destructive tier
-- only on the canonical RPC, preserving explicit approval configuration.
UPDATE app_tools
SET meta = json_set(
	CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,
	'$."com.tedix/policy".riskTier', 'bounded_write',
	'$."com.tedix/policy".blastRadius', 'single_resource'
),
annotations = json_set(
	CASE WHEN json_valid(annotations) THEN annotations ELSE '{}' END,
	'$.readOnlyHint', json('false'), '$.destructiveHint', json('false')
),
write_capability = 'write'
WHERE json_valid(config)
	AND json_extract(config, '$.transport') = 'rpc'
	AND json_extract(config, '$.endpoint') = 'workItems/cancel'
	AND tool_id IN ('cancel_work_item', 'cancel_work_items')
	AND json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,
		'$."com.tedix/policy".owner') IS NULL;
--> statement-breakpoint
-- Connected Notion page creation and non-destructive page commands are bounded
-- workspace writes. The argument policy keeps replacement, deletion, unknown
-- commands and future arguments high risk even under standing consent.
-- Require the configured Notion provider, never a tool name alone.
UPDATE app_tools
SET meta = json_set(
	CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,
	'$."com.tedix/policy".riskTier', 'bounded_write',
	'$."com.tedix/policy".blastRadius', 'single_resource'
)
WHERE json_valid(config)
	AND json_extract(config, '$.transport') = 'mcp'
	AND json_extract(config, '$.mcpToolName') IN (
		'notion-update-page', 'notion_update_page',
		'notion-create-pages', 'notion_create_pages'
	)
	AND (
		json_extract(config, '$.auth.connectionId') = 'notion'
		OR EXISTS (
			SELECT 1 FROM apps
			WHERE apps.id = app_tools.app_id
				AND json_valid(apps.metadata)
				AND json_extract(apps.metadata, '$.mcpConfig.connectionProviderId') = 'notion'
		)
	)
	AND json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,
		'$."com.tedix/policy".owner') IS NULL;
--> statement-breakpoint
UPDATE app_tools
SET meta = json_set(meta,
	'$."com.tedix/policy".argumentPolicy', 'notion_page_update'
)
WHERE json_valid(config) AND json_valid(meta)
	AND json_extract(config, '$.transport') = 'mcp'
	AND json_extract(config, '$.mcpToolName') IN ('notion-update-page', 'notion_update_page')
	AND json_extract(meta, '$."com.tedix/policy".riskTier') = 'bounded_write'
	AND json_extract(meta, '$."com.tedix/policy".owner') IS NULL
	AND (
		json_extract(config, '$.auth.connectionId') = 'notion'
		OR EXISTS (
			SELECT 1 FROM apps
			WHERE apps.id = app_tools.app_id
				AND json_valid(apps.metadata)
				AND json_extract(apps.metadata, '$.mcpConfig.connectionProviderId') = 'notion'
		)
	);
