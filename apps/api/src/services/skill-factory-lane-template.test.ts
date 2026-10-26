import { SkillWorkshopProposeInputSchema } from "@tedix/api-contract/contracts/cognitive";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { validateWorkflowSource } from "@tedix/db/queries/cognitive/skill-validation";
import { describe, expect, it } from "vite-plus/test";
import { renderFactoryLaneSkill } from "./skill-factory-lane-template";

const OWNER = "8d0f3a52-1c7e-4e55-9a0d-5c1f0b6f2a11";

function input() {
	return SkillWorkshopProposeInputSchema.parse({
		slug: "dependency-refresh",
		template: "factory-lane",
		params: {
			ownerTediId: OWNER,
			gatherSteps: [
				{
					name: "current-work",
					tool: "work_items_list",
					args: {
						projectId: "11111111-1111-4111-8111-111111111111",
						limit: 50,
					},
				},
			],
			prompt: "Review dependency updates and propose the safest next work.",
			cycleKey: "2026-10-27",
			maxProposals: 2,
		},
	});
}

type Lane = {
	run(
		event: { payload?: Record<string, unknown> },
		step: {
			do(
				name: string,
				options: unknown,
				run: () => Promise<unknown>,
			): Promise<unknown>;
			sleep(name: string, duration: string): Promise<void>;
		},
		env: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
};

function loadLane(source: string): Lane {
	return new Function(source.replace("export default {", "return {"))() as Lane;
}

describe("factory-lane skill template", () => {
	it("authors a complete lane from one proposal call with an explicit slug", () => {
		const lane = renderFactoryLaneSkill(input());
		expect(lane).toMatchObject({
			title: "Dependency Refresh",
			slug: "dependency-refresh",
			tediId: OWNER,
		});
		expect(lane.content).toContain("factory-lane` template v1");
		const manifest = parseCapabilityManifest(lane.content);
		expect(manifest.mcp.tedi).toEqual([
			"work_items_list",
			"run_tedi_turn",
			"messages_read",
			"work_item_create",
		]);
		expect(
			validateWorkflowSource(
				lane.files!["scripts/workflow.ts"]!,
				"scripts/workflow.ts",
				manifest,
			),
		).toEqual([]);
	});

	it("rejects write tools in deterministic gather steps", () => {
		expect(() =>
			SkillWorkshopProposeInputSchema.parse({
				...input(),
				params: {
					...input().params,
					gatherSteps: [{ name: "write", tool: "work_item_create", args: {} }],
				},
			}),
		).toThrow();
	});

	it("rejects duplicate gather step names", () => {
		expect(() =>
			SkillWorkshopProposeInputSchema.parse({
				...input(),
				params: {
					...input().params,
					gatherSteps: [
						{ name: "work", tool: "work_items_list", args: {} },
						{ name: "work", tool: "work_item_get", args: { id: "x" } },
					],
				},
			}),
		).toThrow(/unique/);
	});

	it("returns a terminal probe receipt without an owner turn or write", async () => {
		const lane = renderFactoryLaneSkill(input());
		const calls: string[] = [];
		const result = await loadLane(lane.files!["scripts/workflow.ts"]!).run(
			{ payload: { probe: true } },
			{
				do: async (_name, _options, run) => run(),
				sleep: async () => undefined,
			},
			{
				__RUN_CONTEXT__: { runId: "probe-run" },
				MCP: {
					tedi: {
						work_items_list: async () => {
							calls.push("work_items_list");
							return { items: [] };
						},
						run_tedi_turn: async () => calls.push("run_tedi_turn"),
						messages_read: async () => calls.push("messages_read"),
						work_item_create: async () => calls.push("work_item_create"),
					},
				},
			},
		);
		expect(result).toEqual({
			template: "factory-lane",
			templateVersion: 1,
			lane: "dependency-refresh",
			cycleKey: "2026-10-27",
			runId: "probe-run",
			gathered: ["current-work"],
			probe: true,
		});
		expect(calls).toEqual(["work_items_list"]);
	});

	it("recovers an async owner reply and deduplicates proposals by cycle", async () => {
		const lane = renderFactoryLaneSkill(input());
		const calls: string[] = [];
		const result = await loadLane(lane.files!["scripts/workflow.ts"]!).run(
			{},
			{
				do: async (_name, _options, run) => run(),
				sleep: async () => undefined,
			},
			{
				__RUN_CONTEXT__: { runId: "normal-run" },
				MCP: {
					tedi: {
						work_items_list: async () => ({ items: [] }),
						run_tedi_turn: async () => {
							calls.push("run_tedi_turn");
							return { pending: true, task: { id: "long-turn" } };
						},
						messages_read: async () => {
							calls.push("messages_read");
							return {
								messages: [
									{
										role: "assistant",
										content:
											'FACTORY_LANE_PROPOSALS {"summary":"ready","proposals":["invalid",{}, {"title":"Upgrade Bun"},{"title":"Upgrade Bun"},{"title":"Upgrade Wrangler"}]}',
									},
								],
							};
						},
						work_item_create: async ({ title }: { title: string }) => {
							calls.push("work_item_create");
							return {
								id: `work-${title.toLowerCase().replace(/\s+/g, "-")}`,
							};
						},
					},
				},
			},
		);
		expect(calls).toEqual([
			"run_tedi_turn",
			"messages_read",
			"work_item_create",
			"work_item_create",
		]);
		expect(result).toMatchObject({
			summary: "ready",
			proposals: [
				{
					title: "Upgrade Bun",
					cycleKey: "2026-10-27",
					proposalKey: "upgrade-bun",
					sourceIntentId:
						"factory-lane:dependency-refresh:2026-10-27:proposal:upgrade-bun",
					workItemId: "work-upgrade-bun",
				},
				{
					title: "Upgrade Wrangler",
					cycleKey: "2026-10-27",
					proposalKey: "upgrade-wrangler",
					sourceIntentId:
						"factory-lane:dependency-refresh:2026-10-27:proposal:upgrade-wrangler",
					workItemId: "work-upgrade-wrangler",
				},
			],
		});
	});

	it("returns no proposals when maxProposals is zero", async () => {
		const zero = input();
		zero.params!.maxProposals = 0;
		const lane = renderFactoryLaneSkill(zero);
		const result = await loadLane(lane.files!["scripts/workflow.ts"]!).run(
			{},
			{
				do: async (_name, _options, run) => run(),
				sleep: async () => undefined,
			},
			{
				MCP: {
					tedi: {
						work_items_list: async () => ({ items: [] }),
						run_tedi_turn: async () => ({
							assistant: {
								content:
									'FACTORY_LANE_PROPOSALS {"summary":"none","proposals":[{"title":"Ignored"}]}',
							},
						}),
						messages_read: async () => ({ messages: [] }),
						work_item_create: async () => ({ id: "unexpected" }),
					},
				},
			},
		);
		expect(result.proposals).toEqual([]);
	});
});
