import { getOsSurface, type OsNavigationItem } from "./os-navigation";

export type OsShellNavigationItem = OsNavigationItem;

export type OsShellNavigationSection = Readonly<{
	label: string;
	items: readonly OsShellNavigationItem[];
}>;

export const OS_SHELL_PRIMARY_NAVIGATION = [
	getOsSurface("work"),
	getOsSurface("chat"),
	getOsSurface("workspaces"),
	getOsSurface("outputs"),
] as const;

/** Setup destinations that sit in the sidebar footer, beside settings. */
export const OS_SHELL_FOOTER_NAVIGATION = [getOsSurface("install")] as const;

export const OS_SHELL_NAVIGATION_SECTIONS = [
	{
		label: "Capabilities",
		items: [
			getOsSurface("team"),
			getOsSurface("skills"),
			getOsSurface("gateways"),
			getOsSurface("sites"),
			getOsSurface("brain"),
		],
	},
	{
		label: "Manage",
		items: [
			getOsSurface("blueprints"),
			getOsSurface("widget"),
			getOsSurface("audit"),
			getOsSurface("compute"),
		],
	},
] as const satisfies readonly OsShellNavigationSection[];

export function isOsShellNavigationItemActive(
	item: OsShellNavigationItem,
	pathname: string,
): boolean {
	if (item.id === "workspaces" && pathname.startsWith("/workspace/"))
		return true;
	// The gateway and the apps it is filled from are one surface, so /apps and
	// every app detail route keep this item selected.
	if (item.id === "gateways" && pathname.startsWith("/apps")) return true;
	if (item.id === "work") {
		return pathname === "/work" || pathname.startsWith("/work/");
	}
	return pathname === item.path || pathname.startsWith(`${item.path}/`);
}

type RouteTitles = Partial<
	Record<"output" | "skill" | "app" | "workspace", string>
>;
type RouteCrumb = { label: string; href?: string };

export function resolveOsShellRouteContext(
	pathname: string,
	titles: RouteTitles = {},
): {
	section?: string;
	crumbs: RouteCrumb[];
} {
	const resources = [
		{
			prefix: "/outputs/",
			parent: "/outputs",
			label: "Outputs",
			title: titles.output ?? "Output",
		},
		{
			prefix: "/skills/",
			parent: "/skills",
			label: "Skills",
			title: titles.skill ?? "Skill",
			section: "Capabilities",
		},
		{
			prefix: "/apps/",
			parent: "/gateways",
			label: "MCP Gateway",
			title: titles.app ?? "App",
			section: "Capabilities",
		},
		{
			prefix: "/workspace/",
			parent: "/workspaces",
			label: "Workspaces",
			title: titles.workspace ?? "Workspace",
		},
	];
	const resource = resources.find(({ prefix }) => pathname.startsWith(prefix));
	if (resource)
		return {
			...(resource.section ? { section: resource.section } : {}),
			crumbs: [
				{ label: resource.label, href: resource.parent },
				{ label: resource.title },
			],
		};
	if (pathname.startsWith("/account/settings")) {
		return { section: "Account", crumbs: [{ label: "Personal settings" }] };
	}
	if (pathname === "/admin" || pathname.startsWith("/admin/")) {
		const destination = {
			"/admin/billing": "Billing",
			"/admin/organization": "Organization",
			"/admin/connections": "Connections",
			"/admin/api-keys": "API keys",
			"/admin/payments": "Payments",
		}[pathname];
		return {
			section: "Manage",
			crumbs: destination
				? [
						{ label: "Organization settings", href: "/admin" },
						{ label: destination },
					]
				: [{ label: "Organization settings" }],
		};
	}
	for (const item of [
		...OS_SHELL_PRIMARY_NAVIGATION,
		...OS_SHELL_FOOTER_NAVIGATION,
	]) {
		if (isOsShellNavigationItemActive(item, pathname))
			return { crumbs: [{ label: item.label }] };
	}
	for (const section of OS_SHELL_NAVIGATION_SECTIONS) {
		const activeItem = section.items.find((item) =>
			isOsShellNavigationItemActive(item, pathname),
		);
		if (activeItem)
			return { section: section.label, crumbs: [{ label: activeItem.label }] };
	}
	return { crumbs: [{ label: "OS" }] };
}
