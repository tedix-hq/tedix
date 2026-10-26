import {
	matchOsPage,
	osPageParents,
	osPagePath,
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
	if (
		item.id === "gateways" &&
		(pathname.startsWith("/apps") || pathname.startsWith("/explore/apps"))
	)
		return true;
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
	const match = matchOsPage(pathname);
	if (!match) return { crumbs: [{ label: "OS" }] };
	const chain = osPageParents(match.page);
	const visible = chain.filter(
		(page) =>
			!page.breadcrumb ||
			(page.breadcrumb === "section" && page === match.page),
	);
	const section = chain.find(
		(page) => page.breadcrumb === "section" && page !== match.page,
	)?.label;
	const crumbs = visible.map((page, index): RouteCrumb => {
		const label =
			(page.titleKey ? titles[page.titleKey] : undefined) ?? page.label;
		return index === visible.length - 1
			? { label }
			: { label, href: osPagePath(page, match.params) };
	});
	return section ? { section, crumbs } : { crumbs };
}
