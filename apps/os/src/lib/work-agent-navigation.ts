import {
	AgentsConfigSchema,
	OfficeConfigSchema,
} from "@tedix/api-contract/schemas/os-session-apps";
import { selectedWorkApp, workHomeSearch } from "./work-home-search";
import { workCapacitySearch } from "./work-route-search";

type WorkApp = {
	gadget: { id: string };
	manifest: { entry?: string; config?: unknown };
};
export type AgentTab = {
	id: "office" | "agents" | "capacity";
	label: string;
	href: string;
	active: boolean;
};

function href(path: string, search: Record<string, unknown>) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(search))
		if (value !== undefined) params.set(key, String(value));
	return params.size ? `${path}?${params}` : path;
}

export function workAgentNavigation(
	apps: readonly WorkApp[],
	pathname: string,
	search: Record<string, unknown>,
) {
	const path = pathname.replace(/\/$/, "");
	const selected =
		typeof search.app === "string"
			? selectedWorkApp(apps, search.app)
			: undefined;
	const tabs: AgentTab[] = [];
	for (const [id, label, schema] of [
		["office", "For you", OfficeConfigSchema],
		["agents", "Sessions", AgentsConfigSchema],
	] as const) {
		const entry = `tedix:app/${id}`;
		const app =
			selected?.manifest.entry === entry &&
			schema.safeParse(selected.manifest.config).success
				? selected
				: apps.find(
						(app) =>
							app.manifest.entry === entry &&
							schema.safeParse(app.manifest.config).success,
					);
		if (!app) continue;
		const active = path === "/work" && selected?.gadget.id === app.gadget.id;
		tabs.push({
			id,
			label,
			active,
			href: href(
				"/work",
				active ? workHomeSearch(search) : { app: app.gadget.id },
			),
		});
	}
	const capacity = path === "/work/capacity";
	tabs.push({
		id: "capacity",
		label: "Capacity",
		active: capacity,
		href: capacity ? href(path, workCapacitySearch(search)) : "/work/capacity",
	});
	return {
		tabs,
		active: tabs.some((tab) => tab.active),
		href:
			tabs.find((tab) => tab.active)?.href ??
			tabs.find((tab) => tab.id === "agents")?.href ??
			tabs[0]!.href,
	};
}
