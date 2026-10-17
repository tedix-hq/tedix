/** Compatibility URLs select the same configured apps, never another fixed view. */
export function legacyWorkRedirect(url: URL): string | null {
	const path = url.pathname.replace(/\/$/, "");
	const aliases: Record<string, string> = {
		"/work/attention": "view=feed&filter=attention",
		"/work/needs-you": "view=deck",
		"/work/control": "view=deck",
		"/work/portfolio": "app=portfolio",
		"/work/agents": "app=agents",
		"/work/office": "app=office",
		"/work/outbound": "app=outbound",
		"/work/attempts": "view=feed&filter=history",
		"/work/history": "view=feed&filter=history",
		"/work/recovery": "view=feed&filter=stalled",
		"/work/stalled": "view=feed&filter=stalled",
	};
	const search =
		path === "/work/queue"
			? `view=feed&filter=${url.searchParams.get("disposition") === "completed" ? "history" : "queue"}`
			: aliases[path];
	return search ? new URL(`/work?${search}`, url.origin).href : null;
}
