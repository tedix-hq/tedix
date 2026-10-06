UPDATE kernel_runtime_runs
SET metadata = replace(
	metadata,
	'"routeKind":"isolate"',
	'"routeKind":"agent"'
)
WHERE json_valid(metadata)
	AND metadata LIKE '%"routeKind":"isolate"%';
