export type OsDevLane =
	| "fixtures"
	| "live-api"
	| "local-worker"
	| "remote-worker";

/**
 * Select one mutually-exclusive Vite lane. Local Worker mode wins over every
 * ambient escape hatch as defense in depth; the dedicated launcher also pins
 * those inherited switches off before Vite starts.
 */
export function resolveOsDevLane(
	environment: NodeJS.ProcessEnv,
	hasLocalApiProxy: boolean,
): OsDevLane {
	if (environment.TEDIX_OS_LOCAL_DEV === "1") return "local-worker";
	if (environment.TEDIX_OS_REMOTE_DEV === "1") return "remote-worker";
	if (environment.VITE_LIVE_API === "1" || hasLocalApiProxy) return "live-api";
	return "fixtures";
}

/** Only the explicit direct/live API lane may install Vite's `/api` proxy. */
export function apiProxyForOsDevLane<T>(
	lane: OsDevLane,
	proxy: T | undefined,
): T | undefined {
	return lane === "live-api" ? proxy : undefined;
}
