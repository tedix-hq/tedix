UPDATE `kernel_runtime_runs`
SET `metadata` = json_set(
	`metadata`,
	'$.kernelRoute.targetActivityId',
	json('null'),
	'$.kernelRoute.plannedToolIds',
	json('[]')
)
WHERE json_type(`metadata`, '$.kernelRoute') = 'object'
	AND json_type(`metadata`, '$.kernelRoute.targetActivityId') IS NULL
	AND json_type(`metadata`, '$.kernelRoute.plannedToolIds') IS NULL;
