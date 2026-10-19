import { OS_COPY } from "@/shared/os-copy";
import {
	OS_SETTINGS_NAVIGATION,
	getOsSurface,
	type OsNavigationItem,
} from "./os-navigation";

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

export const OS_SHELL_NAVIGATION_SECTIONS = [
	{
		label: "Team and tools",
		items: [
			getOsSurface("team"),
			getOsSurface("skills"),
			getOsSurface("gateways"),
			getOsSurface("sites"),
			getOsSurface("brain"),
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
			label: getOsSurface("outputs").label,
			title: titles.output ?? "Document",
		},
		{
			prefix: "/skills/",
			parent: "/skills",
			label: getOsSurface("skills").label,
			title: titles.skill ?? "Skill",
		},
		{
			prefix: "/apps/",
			parent: "/gateways",
			label: getOsSurface("gateways").label,
			title: titles.app ?? "App",
		},
		{
			prefix: "/workspace/",
			parent: "/workspaces",
			label: getOsSurface("workspaces").label,
			title: titles.workspace ?? "Workspace",
		},
	];
	const resource = resources.find(({ prefix }) => pathname.startsWith(prefix));
	if (resource)
		return {
			crumbs: [
				{ label: resource.label, href: resource.parent },
				{ label: resource.title },
			],
		};
	if (pathname.startsWith("/account/settings")) {
		return {
			section: "Account",
			crumbs: [{ label: OS_COPY.navigation.personalSettings }],
		};
	}
	if (pathname === "/admin" || pathname.startsWith("/admin/")) {
		const destination = {
			"/admin/billing": OS_COPY.navigation.compute,
			"/admin/organization": "Organization",
			"/admin/connections": "Connections",
			"/admin/api-keys": "API keys",
			"/admin/payments": "Payments",
		}[pathname];
		return {
			crumbs: destination
				? [
						{ label: OS_COPY.navigation.settings, href: "/admin" },
						{ label: destination },
					]
				: [{ label: OS_COPY.navigation.settings }],
		};
	}
	const settingsItem = OS_SETTINGS_NAVIGATION.find((item) =>
		isOsShellNavigationItemActive(item, pathname),
	);
	if (settingsItem)
		return {
			crumbs: [
				{ label: OS_COPY.navigation.settings, href: "/admin" },
				{ label: settingsItem.label },
			],
		};
	if (pathname === "/install")
		return { crumbs: [{ label: getOsSurface("install").label }] };
	for (const item of OS_SHELL_PRIMARY_NAVIGATION) {
		if (isOsShellNavigationItemActive(item, pathname))
			return { crumbs: [{ label: item.label }] };
	}
	for (const section of OS_SHELL_NAVIGATION_SECTIONS) {
		const activeItem = section.items.find((item) =>
			isOsShellNavigationItemActive(item, pathname),
		);
		if (activeItem) return { crumbs: [{ label: activeItem.label }] };
	}
	return { crumbs: [{ label: "OS" }] };
}
