import { cardSourceSearch } from "./card-source-filter";

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
	project?: string;
	day?: string;
	source?: string;
};

/** The existing Work entry carries app selection and shareable feed filters. */
export function workHomeSearch(
	search: Record<string, unknown>,
): WorkHomeSearch {
	const filter = search.disposition === "completed" ? "history" : search.filter;
	return {
		...(cardSourceSearch(search.source)
			? { source: cardSourceSearch(search.source) }
			: {}),
		...(typeof search.project === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
			search.project,
		)
			? { project: search.project }
			: {}),
		...(typeof search.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.day)
			? { day: search.day }
			: {}),
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
