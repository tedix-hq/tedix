const WORK_REFRESH_MS = 120_000;
const WORK_READ_RETRIES = 3;

export function retryWorkRead(failures: number, error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return (
		failures < WORK_READ_RETRIES &&
		![
			"UNAUTHORIZED",
			"FORBIDDEN",
			"NOT_FOUND",
			"BAD_REQUEST",
			"CONFLICT",
		].includes(code ?? "")
	);
}

/** Equal jitter prevents a returning tab from joining a synchronized retry burst. */
export function workRetryDelay(attempt: number): number {
	const ceiling = Math.min(30_000, 2_000 * 2 ** attempt);
	return ceiling / 2 + (Math.random() * ceiling) / 2;
}

type RefreshQuery = { state: { fetchFailureCount: number } };
function canRefresh(query?: RefreshQuery): boolean {
	return !document.hidden && (!query || query.state.fetchFailureCount === 0);
}

/** Retain TanStack's same-key cache on errors; never carry decisions across keys. */
export const workRefreshOptions = {
	retry: retryWorkRead,
	retryDelay: workRetryDelay,
	refetchInterval: (query?: RefreshQuery): number | false =>
		canRefresh(query) ? WORK_REFRESH_MS : false,
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: canRefresh,
	refetchOnReconnect: canRefresh,
	retryOnMount: false,
} as const;
