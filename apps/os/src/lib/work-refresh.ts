/** Work inboxes have no organization-wide event stream; reconcile quietly. */
const WORK_REFRESH_MS = 120_000;
export const workRefreshOptions = {
	refetchInterval: (): number | false =>
		document.hidden ? false : WORK_REFRESH_MS,
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: "always",
	refetchOnReconnect: "always",
} as const;
