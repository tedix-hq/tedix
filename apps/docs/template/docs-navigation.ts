interface SidebarLinkItem {
	type: "link";
	label: string;
	href: string;
	isCurrent?: boolean;
	order: number;
}

interface SidebarExternalLinkItem {
	type: "external";
	label: string;
	href: string;
	order: number;
}

interface SidebarGroupItem {
	type: "group";
	label: string;
	order: number;
	collapsed?: boolean;
	children: SidebarItem[];
}

export type SidebarItem =
	| SidebarLinkItem
	| SidebarExternalLinkItem
	| SidebarGroupItem;

export const tedixDocsSidebarItems = [
	{
		label: "Start",
		collapsed: false,
		items: [
			"getting-started",
			"learning-paths/first-connection",
			"learning-paths/first-worker",
			"concepts",
			"release-status",
		],
	},
	{
		label: "Troubleshoot",
		collapsed: true,
		items: ["troubleshooting"],
	},
	{
		label: "Work with digital workers",
		collapsed: true,
		items: [
			"workers-and-governance",
			"skills-flows-workflows",
			"mcp-app-platform",
		],
	},
	{
		label: "Publish with Tedix",
		collapsed: true,
		items: ["docs-sites", "cms"],
	},
	{
		label: "Install and operate",
		collapsed: true,
		items: [
			"cli",
			"self-hosted-boundary",
			"installation-manifests",
			"cloudflare-architecture",
			"dependency-pins",
			"telemetry",
		],
	},
	{
		label: "For agents and maintainers",
		collapsed: true,
		items: ["agent-guide", "agents", "licensing"],
	},
];

export function configuredSidebarItems(siteSlug: string) {
	return siteSlug === "tedix"
		? tedixDocsSidebarItems
		: [{ autogenerate: { collection: "docs" } }];
}

function routeKey(href: string): string {
	return href.replace(/\/+$/, "").toLowerCase() || "/";
}

function flattenSidebar(items: SidebarItem[]): SidebarLinkItem[] {
	return items.flatMap((item) =>
		item.type === "group"
			? flattenSidebar(item.children)
			: item.type === "link"
				? [item]
				: [],
	);
}

export function taskLedSidebar(
	items: SidebarItem[],
	siteSlug: string,
	entryPath = "/index",
): SidebarItem[] {
	if (siteSlug !== "tedix") return items;

	const allLinks = flattenSidebar(items);
	const byPath = new Map(allLinks.map((item) => [routeKey(item.href), item]));
	const claimed = new Set<string>([routeKey(entryPath), "/readme"]);
	const result: SidebarItem[] = tedixDocsSidebarItems.flatMap(
		(group, index) => {
			const children = group.items.flatMap((path) => {
				const route = `/${path}`;
				const item = byPath.get(route);
				if (!item) return [];
				claimed.add(route);
				return [item];
			});
			return children.length === 0
				? []
				: [
						{
							type: "group" as const,
							label: group.label,
							order: index,
							collapsed: group.collapsed,
							children,
						},
					];
		},
	);
	const remaining = allLinks.filter(
		(item) => !claimed.has(routeKey(item.href)),
	);
	if (remaining.length > 0) {
		result.push({
			type: "group",
			label: "More",
			order: result.length,
			collapsed: true,
			children: remaining,
		});
	}
	return result;
}
