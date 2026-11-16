import { OS_COPY } from "@/shared/os-copy";
import {
	selectedWorkApp,
	type WORK_APP_ENTRIES,
	type WorkHomeSearch,
} from "@/lib/work-home-search";

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
	/** The Work app this view opens. Without that app the view is not offered. */
	requiresApp?: keyof typeof WORK_APP_ENTRIES;
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
		id: "items",
		label: "All work",
		description:
			"Accepted and finished Work Items with status, owner and priority.",
		group: "planning",
		to: "/work",
		search: { view: "items" },
	},
	{
		id: "projects",
		label: "Projects",
		description: "Every project with its open work and what needs you.",
		group: "planning",
		to: "/work",
		search: { app: "projects" },
	},
	{
		id: "goals",
		get label() {
			return OS_COPY.work.objectives;
		},
		description: "Every goal and the projects and epics serving it.",
		group: "planning",
		to: "/work",
		search: { app: "portfolio" },
	},
	{
		id: "graph",
		label: "Graph",
		description: "Which Work Items have to finish before others can start.",
		group: "planning",
		to: "/work/graph",
	},
	{
		id: "cases",
		label: "Epics",
		description:
			"Bigger pieces of work that group several Work Items under one owner.",
		group: "planning",
		to: "/work/cases",
	},
	{
		id: "triage",
		label: "Triage",
		description:
			"Proposed work waiting for a decision: accept, decline, mark as duplicate or snooze.",
		group: "reviews",
		to: "/work",
		search: { view: "triage" },
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
		description:
			"Which Work Items can start now and what the others are waiting for.",
		group: "reviews",
		to: "/work/admission",
	},
	{
		id: "agents",
		label: "Agents",
		description: "Your requests, agent sessions and available capacity.",
		group: "operations",
		to: "/work",
		search: { app: "agents" },
		requiresApp: "agents",
	},
	{
		id: "office",
		label: "Office",
		description: "What your tedis answered for you and what they are doing.",
		group: "operations",
		to: "/work",
		search: { app: "office" },
		requiresApp: "office",
	},
	{
		id: "outbound",
		label: "Outbound review",
		description: "Messages and documents to check before they go out.",
		group: "operations",
		to: "/work",
		search: { app: "outbound" },
		requiresApp: "outbound",
	},
	{
		id: "capacity",
		label: "Capacity",
		description:
			"Shared resources and budgets, and which ones are full or used up.",
		group: "operations",
		to: "/work/capacity",
	},
	{
		id: "feed-history",
		label: "Finished work",
		description: "What was completed, in Activity.",
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

/**
 * The views this organization can open. A view backed by a Work app is left
 * out until that app is known to be installed, so no entry leads to "This app
 * is not available".
 */
export function openableWorkViews(
	apps: readonly { gadget: { id: string }; manifest: { entry?: string } }[],
): readonly WorkView[] {
	return WORK_VIEWS.filter(
		(view) => !view.requiresApp || selectedWorkApp(apps, view.requiresApp),
	);
}

/** The shareable URL of a view, for plain anchors and tests. */
export function workViewHref(view: WorkView): string {
	if (!view.search) return view.to;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(view.search))
		if (typeof value === "string") params.set(key, value);
	const query = params.toString();
	return query ? `${view.to}?${query}` : view.to;
}

export function workViewsByGroup(
	views: readonly WorkView[] = WORK_VIEWS,
): readonly Readonly<{
	id: WorkViewGroupId;
	label: string;
	views: readonly WorkView[];
}>[] {
	return WORK_VIEW_GROUPS.map((group) => ({
		...group,
		views: views.filter((view) => view.group === group.id),
	})).filter((group) => group.views.length > 0);
}
