UPDATE `kernel_runtime_runs`
SET `metadata` = json_set(
	`metadata`,
	'$.homePlan.dependencies',
	json('[]')
)
WHERE json_valid(`metadata`)
	AND json_type(`metadata`, '$.homePlan') = 'object'
	AND json_type(`metadata`, '$.homePlan.dependencies') IS NULL;
