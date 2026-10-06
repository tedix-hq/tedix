UPDATE `kernel_runtime_runs`
SET `metadata` = json_set(
	`metadata`,
	'$.delegationFailure',
	json_object(
		'ok', json('false'),
		'status', 'failed',
		'reason', CASE
			WHEN json_extract(`metadata`, '$.delegationError') =
				'Runtime preflight failed: tedi is unreachable or stopped'
			THEN 'runtime_unavailable'
			ELSE 'dispatch_failed'
		END,
		'error', json_extract(`metadata`, '$.delegationError'),
		'retryable', CASE
			WHEN json_extract(`metadata`, '$.delegationError') =
				'Runtime preflight failed: tedi is unreachable or stopped'
			THEN json('false')
			ELSE json('true')
		END,
		'childStillRunning', json('false')
	)
)
WHERE json_type(`metadata`, '$.delegationError') = 'text'
	AND json_type(`metadata`, '$.delegationFailure') IS NULL;
