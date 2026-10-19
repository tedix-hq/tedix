import { describe, expect, it } from "vite-plus/test";
import {
	isOsShellNavigationItemActive,
	OS_SHELL_FOOTER_NAVIGATION,
	OS_SHELL_NAVIGATION_SECTIONS,
	OS_SHELL_PRIMARY_NAVIGATION,
	resolveOsShellRouteContext,
} from "./os-shell-navigation";

const OS_SHELL_ALL_NAVIGATION = [
	...OS_SHELL_PRIMARY_NAVIGATION,
	...OS_SHELL_NAVIGATION_SECTIONS.flatMap((section) => section.items),
	...OS_SHELL_FOOTER_NAVIGATION,
];

describe("OS shell navigation", () => {
	it("keeps every Tedix surface reachable through the flat navigation", () => {
		expect(
			OS_SHELL_NAVIGATION_SECTIONS.map((section) => section.label),
		).toEqual(["Capabilities", "Manage"]);
		expect(OS_SHELL_ALL_NAVIGATION.map((item) => item.id)).toEqual([
			"work",
			"chat",
			"workspaces",
			"outputs",
			"team",
			"skills",
			"gateways",
			"sites",
			"brain",
			"blueprints",
			"widget",
			"audit",
			"compute",
			"install",
		]);
	});

	it("keeps parent menus active for nested detail routes", () => {
		const outputs = OS_SHELL_ALL_NAVIGATION.find(
			(item) => item.id === "outputs",
		);
		const work = OS_SHELL_ALL_NAVIGATION.find((item) => item.id === "work");

		expect(outputs).toBeDefined();
		expect(work).toBeDefined();
		expect(isOsShellNavigationItemActive(outputs!, "/outputs/report-1")).toBe(
			true,
		);
		expect(isOsShellNavigationItemActive(work!, "/work/runs/run-1")).toBe(true);
	});

	it("keeps the gateway surface active across its apps catalog", () => {
		const gateways = OS_SHELL_ALL_NAVIGATION.find(
			(item) => item.id === "gateways",
		);

		expect(gateways).toBeDefined();
		expect(isOsShellNavigationItemActive(gateways!, "/gateways")).toBe(true);
		expect(isOsShellNavigationItemActive(gateways!, "/apps")).toBe(true);
		expect(isOsShellNavigationItemActive(gateways!, "/apps/app-1/tools")).toBe(
			true,
		);
		expect(resolveOsShellRouteContext("/apps")).toEqual({
			section: "Capabilities",
			crumbs: [{ label: "MCP Gateway" }],
		});
	});

	it("keeps setup separate from account menu destinations", () => {
		expect(OS_SHELL_FOOTER_NAVIGATION.map((item) => item.path)).toEqual([
			"/install",
		]);
		for (const path of ["/admin"]) {
			expect(resolveOsShellRouteContext(path)).toEqual({
				section: "Manage",
				crumbs: [{ label: "Organization settings" }],
			});
		}
		expect(resolveOsShellRouteContext("/compute")).toEqual({
			section: "Manage",
			crumbs: [{ label: "Usage & budgets" }],
		});
	});

	it("projects section and route context into the top bar", () => {
		expect(resolveOsShellRouteContext("/workspace/workspace-1")).toEqual({
			crumbs: [
				{ label: "Workspaces", href: "/workspaces" },
				{ label: "Workspace" },
			],
		});
		expect(resolveOsShellRouteContext("/work")).toEqual({
			crumbs: [{ label: "Work" }],
		});
		expect(resolveOsShellRouteContext("/team/tedi-1")).toEqual({
			section: "Capabilities",
			crumbs: [{ label: "Team" }],
		});
		expect(resolveOsShellRouteContext("/account/settings")).toEqual({
			section: "Account",
			crumbs: [{ label: "Personal settings" }],
		});
	});
	it("uses real list destinations and resolved resource titles", () => {
		for (const [path, titles, href, label] of [
			[
				"/outputs/document-1",
				{ output: "Booth video 1 script and storyboard" },
				"/outputs",
				"Booth video 1 script and storyboard",
			],
			[
				"/skills/skill-1/versions",
				{ skill: "Research" },
				"/skills",
				"Research",
			],
			["/apps/app-1/tools", { app: "Calendar" }, "/gateways", "Calendar"],
			[
				"/workspace/workspace-1",
				{ workspace: "Revenue Ops" },
				"/workspaces",
				"Revenue Ops",
			],
		] as const) {
			const context = resolveOsShellRouteContext(path, titles);
			expect(context.crumbs[0]?.href).toBe(href);
			expect(context.crumbs[1]).toEqual({ label });
			expect(context.crumbs.some((crumb) => crumb.href === "#")).toBe(false);
		}
		expect(resolveOsShellRouteContext("/admin/billing")).toEqual({
			section: "Manage",
			crumbs: [
				{ label: "Organization settings", href: "/admin" },
				{ label: "Billing" },
			],
		});
	});
});
