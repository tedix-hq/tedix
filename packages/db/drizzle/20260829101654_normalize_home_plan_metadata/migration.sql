UPDATE `kernel_runtime_runs` AS r
SET `metadata` = json_set(
	r.`metadata`,
	'$.homePlan.assignments',
	json((
		SELECT json_group_array(
			CASE
				WHEN json_type(a.value, '$.required') IS NULL
				THEN json_set(a.value, '$.required', json('true'))
				ELSE a.value
			END
		)
		FROM json_each(r.`metadata`, '$.homePlan.assignments') AS a
	))
)
WHERE json_type(r.`metadata`, '$.homePlan') = 'object'
	AND EXISTS (
		SELECT 1
		FROM json_each(r.`metadata`, '$.homePlan.assignments') AS a
		WHERE json_type(a.value, '$.required') IS NULL
	);--> statement-breakpoint
UPDATE `kernel_runtime_events` AS e
SET `payload` = json_set(
	e.`payload`,
	'$.metadata.branchRunIds',
	json_extract(e.`runtime_metadata`, '$.kernelInboxRunIds')
)
WHERE e.`kind` = 'message.completed'
	AND json_type(e.`payload`, '$.metadata.branchRunIds') IS NULL
	AND json_type(e.`runtime_metadata`, '$.kernelInboxRunIds') = 'array'
	AND json_extract(e.`runtime_metadata`, '$.source') = 'kernelRuntime.homePlanFinalSynthesis'
	AND EXISTS (
		SELECT 1
		FROM `kernel_runtime_runs` AS r
		WHERE r.`id` = e.`run_id`
			AND r.`organization_id` = e.`organization_id`
			AND json_type(r.`metadata`, '$.homePlan') = 'object'
	);
