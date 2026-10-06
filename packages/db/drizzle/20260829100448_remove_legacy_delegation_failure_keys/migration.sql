UPDATE `kernel_runtime_runs`
SET `metadata` = json_remove(
	`metadata`,
	'$.delegationError',
	'$.delegationFailureReason'
)
WHERE json_type(`metadata`, '$.delegationFailure') = 'object'
	AND (
		json_type(`metadata`, '$.delegationError') IS NOT NULL
		OR json_type(`metadata`, '$.delegationFailureReason') IS NOT NULL
	);
