import { readFile } from "node:fs/promises";
import { describe, expect, it, mock, spyOn } from "bun:test";
import {
	installAssets,
	installPlan,
	main,
	parseOptions,
	sourceHash,
	type InstallerClient,
} from "./install-calendar-coordinator";
const ORG = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const SKILL = "33333333-3333-4333-8333-333333333333";
const BLUEPRINT = "44444444-4444-4444-8444-444444444444";
const REVISION = "55555555-5555-4555-8555-555555555555";
const baseArgs = [
	"--api-url",
	"https://api.tedix.dev",
	"--organization",
	ORG,
	"--worker",
	WORKER,
	"--google-provider",
	"google-calendar-provider",
	"--google-calendars",
	"2",
];
const applyArgs = [
	...baseArgs,
	"--apply",
	"--reviewed",
	"--review-reason",
	"Reviewed authority, workflow and failure handling",
];
const assets = {
	content:
		"---\nname: calendar-coordinator\ncapabilities:\n  network: false\n  mcp:\n    os: [reconcile_calendar_subscription]\n---\n# Coordinate calendars",
	workflow: "export default { async run() {} };",
};
function harness() {
	const calls: string[] = [];
	let currentDefinition: unknown;
	const options = parseOptions(applyArgs);
	const entry = {
		id: SKILL,
		organizationId: ORG,
		tediId: WORKER,
		slug: options.slug,
		revision: 1,
		lifecycleState: "draft",
		content: assets.content,
		files: { "scripts/workflow.ts": assets.workflow },
		toolIds: ["tool"],
	};
	const worker = {
		id: WORKER,
		organizationId: ORG,
		name: "Calendar worker",
		status: "active",
		retiredAt: null,
	};
	const provider = {
		appId: "google-calendar-provider",
		enabled: true,
		connectionType: "oauth",
		supportedScopes: ["user"],
		availableScopes: ["https://www.googleapis.com/auth/calendar"],
	};
	const api = {
		tedis: { get: mock(async () => worker) },
		connections: { listProviders: mock(async () => ({ data: [provider] })) },
		apps: {
			getBySlugWithTools: mock(async () => ({
				app: { id: "app", slug: "tedix" },
				tools: [
					{
						id: "tool",
						toolId: "reconcile_calendar_subscription",
						config: { endpoint: "calendarCoordinator/reconcileSubscription" },
						enabled: true,
					},
				],
			})),
		},
		skills: {
			listByOrg: mock(async () => ({
				entries: [] as { slug: string }[],
				total: 0,
			})),
			record: mock(async (_input: unknown) => {
				calls.push("record");
				return { entry };
			}),
			improve: mock(async (_input: unknown) => {
				calls.push("improve");
				entry.lifecycleState = "active";
				entry.revision++;
				return { entry };
			}),
			get: mock(async () => {
				calls.push("getSkill");
				return { entry };
			}),
		},
		osWorkspaces: {
			blueprints: {
				list: mock(async () => ({
					items: [] as { name: string }[],
					truncated: false,
				})),
				create: mock(async () => {
					calls.push("createBlueprint");
					return {
						blueprint: {
							id: BLUEPRINT,
							organizationId: ORG,
							status: "draft",
							name: installPlan(options, assets).blueprintName,
						},
					};
				}),
				revise: mock(async (input: { definition: unknown }) => {
					calls.push("reviseBlueprint");
					currentDefinition = input.definition;
					return {};
				}),
				publish: mock(async () => {
					calls.push("publishBlueprint");
					return { revision: { id: REVISION } };
				}),
				get: mock(async () => ({
					blueprint: { organizationId: ORG, status: "published" },
					currentRevision: { id: REVISION, definition: currentDefinition },
				})),
			},
		},
	};
	return {
		options,
		entry,
		worker,
		provider,
		api,
		calls,
		client: api as unknown as InstallerClient,
	};
}
describe("calendar coordinator asset installation", () => {
	it("defaults to local dry run, does not require a key, and does not touch an injected client", async () => {
		const h = harness();
		const options = parseOptions(baseArgs);
		const result = await installAssets(options, assets, h.client);
		expect(result.mode).toBe("dry_run");
		expect(h.api.tedis.get).not.toHaveBeenCalled();
		expect(h.calls).toEqual([]);
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Network is forbidden"),
		);
		try {
			expect((await main(baseArgs, {})).mode).toBe("dry_run");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
	it("rejects apply without explicit review, unsafe origins and malformed selection", () => {
		for (const args of [
			[...baseArgs, "--apply"],
			[...baseArgs, "--apply", "--reviewed"],
			[...baseArgs, "--unknown"],
			[...baseArgs, "--worker", WORKER],
		])
			expect(() => parseOptions(args)).toThrow();
		for (const origin of [
			"http://api.tedix.dev",
			"https://user:secret@api.tedix.dev",
			"https://api.tedix.dev/path",
			"https://api.tedix.dev?key=secret",
		])
			expect(() =>
				parseOptions(
					baseArgs.map((value) =>
						value === "https://api.tedix.dev" ? origin : value,
					),
				),
			).toThrow("HTTPS origin");
	});
	it("creates a new reviewed worker-owned skill, reads back source, and pins the local Blueprint", async () => {
		const h = harness();
		const result = await installAssets(h.options, assets, h.client);
		expect(h.calls).toEqual([
			"record",
			"improve",
			"getSkill",
			"createBlueprint",
			"reviseBlueprint",
			"publishBlueprint",
		]);
		expect(h.api.skills.record.mock.calls[0]?.[0]).toMatchObject({
			tediId: WORKER,
			content: assets.content,
			files: { "scripts/workflow.ts": assets.workflow },
			validate: "error",
			toolIds: ["tool"],
		});
		expect(h.api.skills.record.mock.calls[0]?.[0]).not.toHaveProperty("slug");
		expect(h.api.skills.improve.mock.calls[0]?.[0]).toMatchObject({
			id: SKILL,
			lifecycleState: "active",
			force: true,
		});
		expect(
			h.api.osWorkspaces.blueprints.revise.mock.calls[0]?.[0],
		).toMatchObject({
			expectedRevision: 0,
			definition: {
				gadgets: [],
				requirements: {
					skills: [
						{
							role: "flow",
							skillId: SKILL,
							revision: 2,
							workflowSha256: sourceHash(assets.workflow),
						},
					],
					resources: [
						{ slot: "google_calendar_1", tokenScope: "user" },
						{ slot: "google_calendar_2", tokenScope: "user" },
					],
				},
			},
		});
		expect(result).toMatchObject({
			skillId: SKILL,
			skillRevision: 2,
			blueprintId: BLUEPRINT,
			monitoring: "not_installed",
		});
	});
	it("refuses existing skill, incomplete inventory, or existing Blueprint before writes", async () => {
		for (const mode of ["skill", "incomplete", "blueprint"] as const) {
			const h = harness();
			if (mode === "skill")
				h.api.skills.listByOrg.mockResolvedValue({
					entries: [{ slug: h.options.slug }],
					total: 1,
				});
			if (mode === "incomplete")
				h.api.skills.listByOrg.mockResolvedValue({ entries: [], total: 101 });
			if (mode === "blueprint")
				h.api.osWorkspaces.blueprints.list.mockResolvedValue({
					items: [{ name: installPlan(h.options, assets).blueprintName }],
					truncated: false,
				});
			await expect(installAssets(h.options, assets, h.client)).rejects.toThrow(
				"instead of overwriting",
			);
			expect(h.calls).toEqual([]);
		}
	});
	it("rejects wrong organization, retired worker or insufficient personal provider scopes before writes", async () => {
		for (const mode of [
			"org",
			"retired",
			"scope",
			"provider-disabled",
		] as const) {
			const h = harness();
			if (mode === "org") h.worker.organizationId = "other";
			if (mode === "retired") h.worker.status = "retired";
			if (mode === "scope")
				h.provider.availableScopes = [
					"https://www.googleapis.com/auth/calendar.readonly",
				];
			if (mode === "provider-disabled") h.provider.enabled = false;
			await expect(
				installAssets(h.options, assets, h.client),
			).rejects.toThrow();
			expect(h.calls).toEqual([]);
		}
	});
	it("stops before activation for unexpected created ownership or workflow source", async () => {
		for (const mode of ["owner", "source"] as const) {
			const h = harness();
			if (mode === "owner") h.entry.tediId = "other";
			else h.entry.files["scripts/workflow.ts"] = "unreviewed source";
			await expect(installAssets(h.options, assets, h.client)).rejects.toThrow(
				"stopped before activation",
			);
			expect(h.calls).toEqual(["record"]);
		}
	});
	it("stops before Blueprint creation when post-review readback changed revision source", async () => {
		const h = harness();
		h.api.skills.get.mockImplementationOnce(async () => {
			h.entry.files["scripts/workflow.ts"] = "changed";
			return { entry: h.entry };
		});
		await expect(installAssets(h.options, assets, h.client)).rejects.toThrow(
			"stopped before Blueprint",
		);
		expect(h.api.osWorkspaces.blueprints.create).not.toHaveBeenCalled();
	});
	it("does not replay a failed asset mutation or invoke provider effect endpoints", async () => {
		const h = harness();
		h.api.skills.record.mockRejectedValueOnce(new Error("unknown persistence"));
		await expect(installAssets(h.options, assets, h.client)).rejects.toThrow(
			"unknown persistence",
		);
		expect(h.api.skills.record).toHaveBeenCalledTimes(1);
		expect(h.api.skills.improve).not.toHaveBeenCalled();
		expect(h.api.osWorkspaces.blueprints.create).not.toHaveBeenCalled();
	});
	it("the checked-in asset declares only server reconciliation and has no schedule", async () => {
		const content = await readFile(
			new URL(
				"../../apps/skill-runtime/examples/calendar-coordinator/SKILL.md",
				import.meta.url,
			),
			"utf8",
		);
		const workflow = await readFile(
			new URL(
				"../../apps/skill-runtime/examples/calendar-coordinator/scripts/workflow.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(() =>
			installPlan(parseOptions(baseArgs), { content, workflow }),
		).not.toThrow();
		expect(content).not.toContain("cron:");
		expect(() =>
			installPlan(parseOptions(baseArgs), {
				...assets,
				content: assets.content.replace("network: false", "network: true"),
			}),
		).toThrow("no direct network");
	});
});
