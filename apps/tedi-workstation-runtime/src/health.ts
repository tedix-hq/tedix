export function workstationHealth(
	env: { GIT_SHA?: string },
	eventShapeVersion: string,
) {
	return {
		deployedSha: env.GIT_SHA ?? "unknown",
		eventShapeVersion,
		service: "tedi-workstation-runtime",
		status: "ok",
		timestamp: new Date().toISOString(),
	};
}
