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
	`id` = '000542d5-0000-4000-8000-000000000001'
	AND `templates` LIKE '%D1 + Upstash Vector + Neo4j%';
