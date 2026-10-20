-- The original sanitizer lost SQLite's JSON subtype across its subquery,
-- storing upstream annotations as a string. Decode only object-valued payloads;
-- preserve unrelated metadata, already-correct objects and malformed values.
UPDATE `app_catalog_mcp_tools`
SET `meta` = json_set(
	`meta`,
	'$."tedix/upstreamAnnotations"',
	json(json_extract(`meta`, '$."tedix/upstreamAnnotations"'))
)
WHERE CASE WHEN json_valid(`meta`) THEN
	CASE WHEN json_type(`meta`, '$."tedix/upstreamAnnotations"') = 'text' THEN
		CASE WHEN json_valid(json_extract(`meta`, '$."tedix/upstreamAnnotations"')) THEN
			json_type(json_extract(`meta`, '$."tedix/upstreamAnnotations"')) = 'object'
		ELSE 0 END
	ELSE 0 END
ELSE 0 END;
--> statement-breakpoint
UPDATE `app_tools`
SET `meta` = json_set(
	`meta`,
	'$."tedix/upstreamAnnotations"',
	json(json_extract(`meta`, '$."tedix/upstreamAnnotations"'))
)
WHERE CASE WHEN json_valid(`meta`) THEN
	CASE WHEN json_type(`meta`, '$."tedix/upstreamAnnotations"') = 'text' THEN
		CASE WHEN json_valid(json_extract(`meta`, '$."tedix/upstreamAnnotations"')) THEN
			json_type(json_extract(`meta`, '$."tedix/upstreamAnnotations"')) = 'object'
		ELSE 0 END
	ELSE 0 END
ELSE 0 END;
