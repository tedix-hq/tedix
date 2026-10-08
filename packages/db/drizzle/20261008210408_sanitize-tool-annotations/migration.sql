-- Sanitize stored MCP tool annotations to the ToolAnnotations shape.
-- Upstream servers send non-standard keys (cost, progressHint, returnDirect,
-- x-openai-isConsequential, ...). The catalog read path validates annotations
-- against ToolAnnotationsSchema (title + four boolean hints, no other keys),
-- so one foreign key made the whole catalog entry unreadable over MCP.
-- Keep only `title` (text) and the four hints (booleans); move every other key
-- into `meta`."tedix/upstreamAnnotations"; a row left with no valid key gets
-- NULL annotations. Non-object annotations become NULL. Only rows that still
-- contain a foreign key match, so re-running changes nothing.
UPDATE `app_catalog_mcp_tools`
SET
	`meta` = CASE
		WHEN `meta` IS NULL THEN json_object(
			'tedix/upstreamAnnotations',
			(SELECT json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) FROM json_each(`app_catalog_mcp_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))))
		)
		WHEN json_valid(`meta`) THEN CASE
			WHEN json_type(`meta`) = 'object' THEN json_set(
				`meta`,
				'$."tedix/upstreamAnnotations"',
				(SELECT json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) FROM json_each(`app_catalog_mcp_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))))
			)
			ELSE `meta`
		END
		ELSE `meta`
	END,
	`annotations` = (
		SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) END
		FROM json_each(`app_catalog_mcp_tools`.`annotations`)
		WHERE (key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))
	)
WHERE `annotations` IS NOT NULL
	AND CASE
		WHEN json_valid(`annotations`) THEN CASE
			WHEN json_type(`annotations`) = 'object' THEN EXISTS (
				SELECT 1 FROM json_each(`app_catalog_mcp_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false')))
			)
			ELSE 0
		END
		ELSE 0
	END;
--> statement-breakpoint
UPDATE `app_catalog_mcp_tools`
SET `annotations` = NULL
WHERE `annotations` IS NOT NULL
	AND CASE
		WHEN json_valid(`annotations`) THEN json_type(`annotations`) != 'object'
		ELSE 1
	END;
--> statement-breakpoint
UPDATE `app_tools`
SET
	`meta` = CASE
		WHEN `meta` IS NULL THEN json_object(
			'tedix/upstreamAnnotations',
			(SELECT json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) FROM json_each(`app_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))))
		)
		WHEN json_valid(`meta`) THEN CASE
			WHEN json_type(`meta`) = 'object' THEN json_set(
				`meta`,
				'$."tedix/upstreamAnnotations"',
				(SELECT json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) FROM json_each(`app_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))))
			)
			ELSE `meta`
		END
		ELSE `meta`
	END,
	`annotations` = (
		SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_object(key, json(CASE WHEN type = 'text' THEN json_quote(value) WHEN type IN ('object', 'array') THEN value WHEN type IN ('true', 'false', 'null') THEN type ELSE CAST(value AS TEXT) END)) END
		FROM json_each(`app_tools`.`annotations`)
		WHERE (key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false'))
	)
WHERE `annotations` IS NOT NULL
	AND CASE
		WHEN json_valid(`annotations`) THEN CASE
			WHEN json_type(`annotations`) = 'object' THEN EXISTS (
				SELECT 1 FROM json_each(`app_tools`.`annotations`) WHERE NOT ((key = 'title' AND type = 'text') OR (key IN ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') AND type IN ('true', 'false')))
			)
			ELSE 0
		END
		ELSE 0
	END;
--> statement-breakpoint
UPDATE `app_tools`
SET `annotations` = NULL
WHERE `annotations` IS NOT NULL
	AND CASE
		WHEN json_valid(`annotations`) THEN json_type(`annotations`) != 'object'
		ELSE 1
	END;
