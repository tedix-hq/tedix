import { describe, expect, it } from "vite-plus/test";
import { workHomeSearch, selectedWorkApp } from "./work-home-search";
import { workAgentNavigation } from "./work-agent-navigation";

const office = {
	gadget: { id: "11111111-1111-4111-8111-111111111111" },
	manifest: { entry: "tedix:app/office", config: { version: 1 } },
};
const agents = {
	gadget: { id: "22222222-2222-4222-8222-222222222222" },
	manifest: {
		entry: "tedix:app/agents",
		config: { version: 1, projectId: "33333333-3333-4333-8333-333333333333" },
	},
};

describe("Agents navigation", () => {
	it("links only valid viewer-visible app instances and retains Capacity without installing apps", () => {
		const invalid = {
			...agents,
			manifest: { ...agents.manifest, config: { version: 2 } },
		};
		const navigation = workAgentNavigation([invalid, office], "/work", {
			app: "office",
		});
		expect(navigation.tabs.map((tab) => tab.label)).toEqual([
			"For you",
			"Capacity",
		]);
		expect(navigation.tabs[0]).toMatchObject({
			active: true,
			href: "/work?app=office",
		});
		expect(workAgentNavigation([], "/work/capacity", {}).tabs).toHaveLength(1);
		expect(workAgentNavigation([], "/work", { view: "feed" }).active).toBe(
			false,
		);
		expect(
			workAgentNavigation([office, agents], "/work", { view: "feed" }).href,
		).toBe(`/work?app=${agents.gadget.id}`);
	});

	it("opens the exact configured instance by UUID while keeping legacy aliases", () => {
		const second = {
			...agents,
			gadget: { id: "44444444-4444-4444-8444-444444444444" },
			manifest: {
				...agents.manifest,
				config: {
					version: 1,
					projectId: "55555555-5555-4555-8555-555555555555",
				},
			},
		};
		const apps = [office, agents, second];
		expect(selectedWorkApp(apps, "agents")).toBe(agents);
		expect(selectedWorkApp(apps, second.gadget.id)).toBe(second);
		expect(selectedWorkApp([office], second.gadget.id)).toBeUndefined();
		const search = workHomeSearch({
			app: second.gadget.id,
			project: second.manifest.config.projectId,
		});
		expect(search.app).toBe(second.gadget.id);
		const navigation = workAgentNavigation(apps, "/work", search);
		expect(navigation.tabs.find((tab) => tab.active)).toMatchObject({
			id: "agents",
			href: `/work?project=${second.manifest.config.projectId}&app=${second.gadget.id}`,
		});
		expect(selectedWorkApp(apps, search.app!)?.manifest.config).toEqual(
			second.manifest.config,
		);
		expect(workHomeSearch({ app: "arbitrary-text" })).toEqual({});
	});

	it("retains active Capacity filters and has a single active destination", () => {
		const navigation = workAgentNavigation(
			[office, agents],
			"/work/capacity/",
			{
				view: "budgets",
				exhausted: true,
				resourceKey: "review.pool",
				saturated: false,
			},
		);
		expect(navigation.tabs.map((tab) => tab.label)).toEqual([
			"For you",
			"Sessions",
			"Capacity",
		]);
		expect(navigation.tabs.filter((tab) => tab.active)).toHaveLength(1);
		expect(navigation.href).toBe(
			"/work/capacity?resourceKey=review.pool&saturated=false&view=budgets&exhausted=true",
		);
		expect(navigation.tabs[1]?.href).toBe(`/work?app=${agents.gadget.id}`);
	});
});
