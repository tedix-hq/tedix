import { describe, expect, it } from "vite-plus/test";
import {
	isOsShellNavigationItemActive,
	OS_SHELL_NAVIGATION_SECTIONS,
	OS_SHELL_PRIMARY_NAVIGATION,
	resolveOsShellRouteContext,
} from "./os-shell-navigation";

const OS_SHELL_ALL_NAVIGATION = [
	...OS_SHELL_PRIMARY_NAVIGATION,
	...OS_SHELL_NAVIGATION_SECTIONS.flatMap((section) => section.items),
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
			"install",
			"team",
			"skills",
			"gateways",
			"sites",
			"brain",
			"blueprints",
			"widget",
			"audit",
			"compute",
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
			label: "MCP Gateway",
		});
	});

	it("projects section and route context into the top bar", () => {
		expect(resolveOsShellRouteContext("/workspace/workspace-1")).toEqual({
			label: "Workspaces",
		});
		expect(resolveOsShellRouteContext("/work")).toEqual({ label: "Work" });
		expect(resolveOsShellRouteContext("/team/tedi-1")).toEqual({
			section: "Capabilities",
			label: "Team",
		});
		expect(resolveOsShellRouteContext("/account/settings")).toEqual({
			section: "Account",
			label: "Personal settings",
		});
	});
});
