UPDATE `workspace_template_sets`
SET
	`templates` = replace(
		`templates`,
		'D1 + Upstash Vector + Neo4j',
		'D1 + Cloudflare Agent Memory + Neo4j'
	),
	`version` = `version` + 1,
	`updated_at` = CURRENT_TIMESTAMP
WHERE
	`scope` = 'system'
	AND `slug` = 'system-default'
	AND `templates` LIKE '%D1 + Upstash Vector + Neo4j%';
