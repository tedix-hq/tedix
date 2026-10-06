UPDATE `app_tools`
SET `write_capability` = CASE
		WHEN json_extract(`annotations`, '$.destructiveHint') = 1 THEN 'destructive'
		WHEN json_extract(`annotations`, '$.readOnlyHint') = 1 THEN 'read'
		WHEN json_extract(`annotations`, '$.readOnlyHint') = 0
			OR json_extract(`annotations`, '$.destructiveHint') = 0 THEN 'write'
		ELSE NULL
	END
WHERE `write_capability` IS NULL
	AND `annotations` IS NOT NULL
	AND json_valid(`annotations`);
