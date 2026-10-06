export function workstationHealth(
	env: { BACKUP_BUCKET?: unknown; GIT_SHA?: string },
	eventShapeVersion: string,
) {
	return {
		backupBucketConfigured: Boolean(env.BACKUP_BUCKET),
		deployedSha: env.GIT_SHA ?? "unknown",
		eventShapeVersion,
		service: "tedi-workstation-runtime",
		status: "ok",
		timestamp: new Date().toISOString(),
	};
}
