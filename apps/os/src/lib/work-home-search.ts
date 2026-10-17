const WORK_FEED_FILTERS = [
	"all",
	"attention",
	"office",
	"history",
	"stalled",
	"queue",
] as const;
export type WorkFeedFilter = (typeof WORK_FEED_FILTERS)[number];
export const WORK_APP_ENTRIES = {
	portfolio: "tedix:app/portfolio",
	agents: "tedix:app/agents",
	office: "tedix:app/office",
	outbound: "tedix:app/outbound-review",
} as const;
type WorkAppName = keyof typeof WORK_APP_ENTRIES;
export type WorkHomeSearch = {
	view?: "feed" | "deck";
	filter?: WorkFeedFilter;
	app?: WorkAppName;
};

/** The existing Work entry carries app selection and shareable feed filters. */
export function workHomeSearch(
	search: Record<string, unknown>,
): WorkHomeSearch {
	const filter = search.disposition === "completed" ? "history" : search.filter;
	return {
		...(search.view === "deck" || search.view === "feed"
			? { view: search.view }
			: {}),
		...(typeof filter === "string" &&
		WORK_FEED_FILTERS.includes(filter as WorkFeedFilter)
			? { filter: filter as WorkFeedFilter }
			: {}),
		...(typeof search.app === "string" &&
		Object.hasOwn(WORK_APP_ENTRIES, search.app)
			? { app: search.app as WorkAppName }
			: {}),
	};
}
