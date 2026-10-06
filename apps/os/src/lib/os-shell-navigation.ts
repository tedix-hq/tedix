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
	getOsSurface("install"),
] as const;

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

export function resolveOsShellRouteContext(pathname: string): {
	section?: string;
	label: string;
} {
	if (pathname.startsWith("/account/settings")) {
		return { section: "Account", label: "Personal settings" };
	}
	if (pathname.startsWith("/admin")) {
		return { section: "Manage", label: "Admin" };
	}

	for (const item of OS_SHELL_PRIMARY_NAVIGATION) {
		if (isOsShellNavigationItemActive(item, pathname)) {
			return { label: item.label };
		}
	}

	for (const section of OS_SHELL_NAVIGATION_SECTIONS) {
		const activeItem = section.items.find((item) =>
			isOsShellNavigationItemActive(item, pathname),
		);
		if (activeItem) return { section: section.label, label: activeItem.label };
	}

	return { label: "OS" };
}
