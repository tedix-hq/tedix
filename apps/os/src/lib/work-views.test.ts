import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { routeTree } from "@/routeTree.gen";
import { workHomeSearch } from "@/lib/work-home-search";
import {
	WORK_VIEW_GROUPS,
	WORK_VIEWS,
	workViewHref,
	workViewsByGroup,
} from "./work-views";

const routePaths = new Set(
	Object.values(
		createRouter({ routeTree, context: { queryClient: new QueryClient() } })
			.routesById as unknown as Record<string, { fullPath: string }>,
	).map((route) => route.fullPath),
);

describe("Work views registry", () => {
	it("lists every secondary Work page once, with a group and a description", () => {
		expect(WORK_VIEWS.map(workViewHref)).toEqual([
			"/work?app=portfolio",
			"/work/graph",
			"/work/cases",
			"/work/clusters",
			"/work/approvals",
			"/work/interactions",
			"/work/admission",
			"/work?app=agents",
			"/work?app=office",
			"/work?app=outbound",
			"/work/capacity",
			"/work?view=feed&filter=history",
			"/work?view=feed&filter=stalled",
		]);
		expect(new Set(WORK_VIEWS.map((view) => view.id)).size).toBe(
			WORK_VIEWS.length,
		);
		for (const view of WORK_VIEWS) {
			expect(view.description.endsWith("."), view.id).toBe(true);
			expect(
				WORK_VIEW_GROUPS.some((group) => group.id === view.group),
				view.id,
			).toBe(true);
		}
	});

	it("points only at routes that exist and search the Work entry validates", () => {
		for (const view of WORK_VIEWS) {
			expect(routePaths, view.id).toContain(view.to);
			if (view.to === "/work")
				expect(workHomeSearch(view.search), view.id).toEqual(view.search);
		}
	});

	it("never promotes Feed or Deck into the secondary list", () => {
		expect(WORK_VIEWS.map(workViewHref)).not.toContain("/work?view=feed");
		expect(WORK_VIEWS.map(workViewHref)).not.toContain("/work?view=deck");
	});

	it("groups views in the declared order and drops empty groups", () => {
		const groups = workViewsByGroup();
		expect(groups.map((group) => group.id)).toEqual([
			"planning",
			"reviews",
			"operations",
			"history",
		]);
		expect(groups.flatMap((group) => group.views)).toHaveLength(
			WORK_VIEWS.length,
		);
	});
});
