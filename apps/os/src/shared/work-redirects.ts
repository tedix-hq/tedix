/**
 * Old Work URLs and the Work view each one opens. The Worker redirects page
 * loads from this table; there are no route files for these paths.
 */
export const LEGACY_WORK_SEARCH = {
	"/work/attention": { view: "feed", filter: "attention" },
	"/work/needs-you": { view: "deck" },
	"/work/portfolio": { app: "portfolio" },
	"/work/agents": { app: "agents" },
	"/work/office": { app: "office" },
	"/work/outbound": { app: "outbound" },
	"/work/attempts": { view: "feed", filter: "history" },
	"/work/history": { view: "feed", filter: "history" },
	"/work/recovery": { view: "feed", filter: "stalled" },
	"/work/stalled": { view: "feed", filter: "stalled" },
	"/work/queue": { view: "feed", filter: "queue" },
} as const;

/** Finished work used to be `/work/queue?disposition=completed`. */
export function legacyWorkQueueSearch(search: { disposition?: unknown }) {
	return search.disposition === "completed"
		? LEGACY_WORK_SEARCH["/work/history"]
		: LEGACY_WORK_SEARCH["/work/queue"];
}

export function legacyWorkRedirect(url: URL): string | null {
	const path = url.pathname.replace(/\/$/, "");
	if (!Object.hasOwn(LEGACY_WORK_SEARCH, path)) return null;
	const search =
		path === "/work/queue"
			? legacyWorkQueueSearch({
					disposition: url.searchParams.get("disposition"),
				})
			: LEGACY_WORK_SEARCH[path as keyof typeof LEGACY_WORK_SEARCH];
	return new URL(`/work?${new URLSearchParams(search)}`, url.origin).href;
}
