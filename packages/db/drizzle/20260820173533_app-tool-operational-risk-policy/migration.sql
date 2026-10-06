UPDATE `app_tools`
SET `meta` = json_set(
	CASE WHEN json_valid(`meta`) THEN `meta` ELSE '{}' END,
	'$."com.tedix/policy".riskTier',
	CASE
		WHEN `write_capability` <> 'read'
			AND json_valid(`config`)
			AND json_extract(`config`, '$.transport') IN ('external', 'mcp')
			THEN 'external_side_effect'
		WHEN `write_capability` = 'destructive' THEN 'high_impact_write'
		WHEN `write_capability` = 'write' THEN 'bounded_write'
		WHEN `write_capability` = 'read' THEN 'read'
	END
)
WHERE `write_capability` IS NOT NULL
	AND (
		NOT json_valid(`meta`)
		OR json_extract(`meta`, '$."com.tedix/policy".riskTier') IS NULL
	);

UPDATE `app_tools`
SET `meta` = json_set(
	`meta`,
	'$."com.tedix/policy".blastRadius',
	CASE json_extract(`meta`, '$."com.tedix/policy".riskTier')
		WHEN 'read' THEN 'none'
		WHEN 'bounded_write' THEN 'single_resource'
		WHEN 'high_impact_write' THEN 'tenant'
		WHEN 'external_side_effect' THEN 'external_system'
	END
)
WHERE json_valid(`meta`)
	AND json_extract(`meta`, '$."com.tedix/policy".riskTier') IS NOT NULL
	AND json_extract(`meta`, '$."com.tedix/policy".blastRadius') IS NULL;
