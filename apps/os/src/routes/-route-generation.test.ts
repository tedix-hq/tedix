import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { routeTree } from "@/routeTree.gen";

const OS_ROOT = /[\\/]apps[\\/]os$/.test(process.cwd())
	? process.cwd()
	: resolve(process.cwd(), "apps/os");

const read = (relative: string) => {
	return readFileSync(resolve(OS_ROOT, relative), "utf8");
};

const expectedPaths = [
	"/",
	"/account/onboarding",
	"/account/organizations",
	"/account/profile",
	"/account/authorizations",
	"/work/runs/$runId",
	"/work/executions/$runId",
	"/work",
	"/work/portfolio",
	"/work/graph",
	"/work/items/$workItemId",
	"/work/projects/$projectId",
	"/work/attempts",
	"/work/approvals",
	"/work/admission",
	"/work/capacity",
	"/work/cases",
	"/work/cases/$caseId",
	"/work/control",
	"/work/interactions",
	"/work/interactions/$requestId",
	"/work/recovery",
	"/admin",
	"/admin/api-keys",
	"/admin/billing",
	"/admin/organization",
	"/admin/payments",
	"/apps",
	"/apps/$appId",
	"/apps/$appId/analytics",
	"/apps/$appId/content",
	// The evals list is the index child of a pathless evals segment, so its
	// generated fullPath keeps the trailing slash.
	"/apps/$appId/evals/",
	"/apps/$appId/evals/$evalId",
	"/apps/$appId/settings",
	"/apps/$appId/tools",
	"/explore/apps",
	"/explore/apps/$slug",
	"/audit",
	"/blueprints",
	"/brain",
	"/chat",
	"/cli/login",
	"/compute",
	"/invite",
	"/install",
	"/login",
	"/outputs",
	"/outputs/$outputId",
	"/account/settings",
	"/account/connections",
	"/shared",
	"/skills",
	"/team",
	"/team/$tediId",
	"/team/$tediId/authority",
	"/team/$tediId/learning",
	"/team/$tediId/memory",
	"/team/$tediId/settings",
	"/team/$tediId/telemetry",
	"/team/new",
	"/workspaces",
] as const;

type RouteNode = { fullPath: string; parentRoute?: { id: string } };
const routes = createRouter({
	routeTree,
	context: { queryClient: new QueryClient() },
}).routesById as unknown as Record<string, RouteNode>;
const parentOf = (id: string) => {
	expect(routes[id], id).toBeDefined();
	return routes[id]!.parentRoute?.id;
};

describe("OS route generation", () => {
	it("preserves every product URL in the route tree", () => {
		const fullPaths = new Set(
			Object.values(routes).map((route) => route.fullPath),
		);
		for (const path of expectedPaths) expect(fullPaths, path).toContain(path);
	});

	it("keeps the retired evidence plane out of the product routes", () => {
		expect(
			Object.values(routes).some(
				(route) => route.fullPath === "/work/evidence",
			),
		).toBe(false);
	});

	it("uses automatic route splitting instead of a manual route tree", () => {
		const viteConfig = read("vite.config.ts");

		expect(viteConfig).toContain("autoCodeSplitting: true");
		expect(viteConfig).toContain("TanStackRouterVite");
		expect(existsSync(resolve(OS_ROOT, "src/routes.tsx"))).toBe(false);
	});

	it("parents the promoted account surface under the product session branch", () => {
		// The `/account` layout hangs off the product `_session` SessionBoundary,
		// so the launcher/onboarding inherit its broker resume/renewal + identity
		// without instantiating a second capability-lifecycle boundary.
		expect(parentOf("/_session/account")).toBe("/_session");
		for (const id of [
			"/_session/account/organizations",
			"/_session/account/onboarding",
			"/_session/account/profile",
			"/_session/account/authorizations",
		])
			expect(parentOf(id)).toBe("/_session/account");
	});

	it("keeps personal account pages inside the tenant shell", () => {
		for (const id of [
			"/_session/_tenant/account/settings",
			"/_session/_tenant/account/connections",
		])
			expect(parentOf(id)).toBe("/_session/_tenant");
	});

	it("assigns auth, CLI, shared, and Workspace to explicit layout branches", () => {
		expect(parentOf("/_auth/login")).toBe("/_auth");
		expect(parentOf("/_cli-session/cli/login")).toBe("/_cli-session");
		expect(parentOf("/_session/_chrome-free/shared")).toBe(
			"/_session/_chrome-free",
		);
		expect(parentOf("/_session/_chrome-free/workspace_/$workspaceId")).toBe(
			"/_session/_chrome-free",
		);
	});
});
