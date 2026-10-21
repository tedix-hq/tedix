import { afterEach } from "vite-plus/test";
import { setOsLocale } from "@/shared/os-locale";
import {
	OS_PAGES,
	OS_SETTINGS_NAVIGATION,
	getOsSurface,
} from "./os-navigation";
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
		).toEqual(["Team and tools"]);
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
			crumbs: [{ label: "Connections" }],
		});
	});

	it("keeps setup separate from account menu destinations", () => {
		for (const path of ["/admin"]) {
			expect(resolveOsShellRouteContext(path)).toEqual({
				crumbs: [{ label: "Settings" }],
			});
		}
		expect(resolveOsShellRouteContext("/compute")).toEqual({
			crumbs: [{ label: "Settings", href: "/admin" }, { label: "Usage" }],
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
			crumbs: [{ label: "Settings", href: "/admin" }, { label: "Billing" }],
		});
	});
});

afterEach(() => setOsLocale("en-US"));
describe("navigation translations", () => {
	it.each([
		["en-US", "Usage", "Billing"],
		["es-ES", "Uso", "Facturación"],
	] as const)(
		"keeps usage and billing titles distinct in %s",
		(locale, usage, billing) => {
			setOsLocale(locale);
			const pages = ["/compute", "/admin/billing"].map((path) =>
				OS_PAGES.find((page) => page.path === path),
			);
			expect(pages.map((page) => page?.label)).toEqual([usage, billing]);
			expect(new Set(pages.map((page) => page?.label)).size).toBe(2);
			for (const page of pages) {
				expect(page?.palette).toBe(true);
				expect(
					resolveOsShellRouteContext(page!.path).crumbs.at(-1)?.label,
				).toBe(page!.label);
			}
		},
	);
	it("updates existing navigation items when Spanish preferences arrive", () => {
		setOsLocale("es-ES");
		expect(getOsSurface("outputs").label).toBe("Documentos");
		expect(getOsSurface("gateways").description).toBe(
			"Apps y herramientas que Tedix puede usar por ti.",
		);
		expect(OS_SETTINGS_NAVIGATION.map((item) => item.label)).toEqual([
			"Plantillas",
			"Chat del sitio web",
			"Registro de actividad",
			"Uso",
		]);
		expect(getOsSurface("gateways").label).toBe("Conexiones");
		expect(getOsSurface("sites").label).toBe("Sitios web");
		expect(getOsSurface("brain").label).toBe("Memoria");
		expect(getOsSurface("install").label).toBe("Instalar apps");
	});
	it("keeps each settings destination reachable at its existing URL", () => {
		for (const item of OS_SETTINGS_NAVIGATION)
			expect(resolveOsShellRouteContext(item.path).crumbs).toEqual([
				{ label: "Settings", href: "/admin" },
				{ label: item.label },
			]);
	});
});

describe("deep page breadcrumbs", () => {
	it.each([
		[
			"/admin/organization",
			{
				crumbs: [
					{ label: "Settings", href: "/admin" },
					{ label: "Organization" },
				],
			},
		],
		[
			"/admin/api-keys",
			{
				crumbs: [{ label: "Settings", href: "/admin" }, { label: "API keys" }],
			},
		],
		[
			"/account/profile",
			{ section: "Account", crumbs: [{ label: "Profile" }] },
		],
		[
			"/account/connections",
			{ section: "Account", crumbs: [{ label: "Connected applications" }] },
		],
		["/team/tedi-1/memory", { crumbs: [{ label: "Team" }] }],
		["/team/tedi-1/authority", { crumbs: [{ label: "Team" }] }],
	])("resolves %s without changing established labels", (path, expected) => {
		expect(resolveOsShellRouteContext(path)).toEqual(expected);
	});
	it("has no OS fallback for registered routes, including trailing slashes", () => {
		for (const page of OS_PAGES) {
			const sample = page.path.replace(/\$[A-Za-z]+/g, "sample-id");
			for (const path of [sample, sample === "/" ? "/" : `${sample}/`]) {
				expect(
					resolveOsShellRouteContext(path).crumbs.length,
					path,
				).toBeGreaterThan(0);
				expect(
					resolveOsShellRouteContext(path).crumbs.some(
						(crumb) => crumb.label === "OS",
					),
					path,
				).toBe(false);
			}
		}
	});
});
