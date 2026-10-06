UPDATE `organizations`
SET `features` = json_remove(
	json_set(
		`features`,
		'$.os',
		json(CASE json_type(`features`, '$.nativeOs') WHEN 'true' THEN 'true' ELSE 'false' END)
	),
	'$.nativeOs'
)
WHERE json_type(`features`, '$.nativeOs') IS NOT NULL;
