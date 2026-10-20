import type { WorkHomeSearch } from "@/lib/work-home-search";

/**
 * Every Work view a person can open on purpose.
 *
 * Feed and Deck stay the only primary views in the Work header. The rest is
 * listed in ⌘K ("Go to …") and in the header's quiet "More views" menu, so no
 * page needs a tab, a sidebar row or a route of its own to stay reachable.
 */
export type WorkViewGroupId = "planning" | "reviews" | "operations" | "history";

export type WorkView = Readonly<{
	id: string;
	label: string;
	/** One plain sentence: what the person sees there. */
	description: string;
	group: WorkViewGroupId;
}> &
	Readonly<
		| { to: "/work"; search: WorkHomeSearch }
		| {
				to:
					| "/work/approvals"
					| "/work/interactions"
					| "/work/admission"
					| "/work/graph"
					| "/work/cases"
					| "/work/clusters"
					| "/work/capacity";
				search?: undefined;
		  }
	>;

export const WORK_VIEW_GROUPS: readonly Readonly<{
	id: WorkViewGroupId;
	label: string;
}>[] = [
	{ id: "planning", label: "Planning" },
	{ id: "reviews", label: "Reviews" },
	{ id: "operations", label: "Operations" },
	{ id: "history", label: "History" },
];

export const WORK_VIEWS: readonly WorkView[] = [
	{
		id: "projects",
		label: "Projects",
		description: "Every project, its owner and what comes next.",
		group: "planning",
		to: "/work",
		search: { app: "portfolio" },
	},
	{
		id: "graph",
		label: "Graph",
		description: "How work items depend on each other.",
		group: "planning",
		to: "/work/graph",
	},
	{
		id: "cases",
		label: "Cases",
		description: "Longer-running cases and the work filed under them.",
		group: "planning",
		to: "/work/cases",
	},
	{
		id: "clusters",
		label: "Clusters",
		description: "Related work grouped together.",
		group: "planning",
		to: "/work/clusters",
	},
	{
		id: "approvals",
		label: "Approvals",
		description: "Work proposals waiting for a person to approve.",
		group: "reviews",
		to: "/work/approvals",
	},
	{
		id: "requests",
		label: "Requests",
		description: "Questions asked of you, by you and across the organization.",
		group: "reviews",
		to: "/work/interactions",
	},
	{
		id: "admission",
		label: "Admission",
		description: "Which agent sessions hold work and under what lease.",
		group: "reviews",
		to: "/work/admission",
	},
	{
		id: "agents",
		label: "Agents",
		description: "Coding sessions running on your machines right now.",
		group: "operations",
		to: "/work",
		search: { app: "agents" },
	},
	{
		id: "office",
		label: "Office",
		description: "What your tedis answered for you and what they are doing.",
		group: "operations",
		to: "/work",
		search: { app: "office" },
	},
	{
		id: "outbound",
		label: "Outbound review",
		description: "Messages and documents to check before they go out.",
		group: "operations",
		to: "/work",
		search: { app: "outbound" },
	},
	{
		id: "capacity",
		label: "Capacity",
		description: "Resource pools and budgets, and which ones are full.",
		group: "operations",
		to: "/work/capacity",
	},
	{
		id: "feed-history",
		label: "Finished work",
		description: "What was completed, in the Feed.",
		group: "history",
		to: "/work",
		search: { view: "feed", filter: "history" },
	},
	{
		id: "feed-stalled",
		label: "Stalled work",
		description: "Work that stopped moving and may need a nudge.",
		group: "history",
		to: "/work",
		search: { view: "feed", filter: "stalled" },
	},
];

/** The shareable URL of a view, for plain anchors and tests. */
export function workViewHref(view: WorkView): string {
	if (!view.search) return view.to;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(view.search))
		if (typeof value === "string") params.set(key, value);
	const query = params.toString();
	return query ? `${view.to}?${query}` : view.to;
}

export function workViewsByGroup(): readonly Readonly<{
	id: WorkViewGroupId;
	label: string;
	views: readonly WorkView[];
}>[] {
	return WORK_VIEW_GROUPS.map((group) => ({
		...group,
		views: WORK_VIEWS.filter((view) => view.group === group.id),
	})).filter((group) => group.views.length > 0);
}
