import { CreateFactoryInputSchema } from "@tedix/api-contract/schemas/factories";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { validateSkillSchedulePolicy } from "@tedix/api-contract/utils/skill-schedule";
import { validateWorkflowSource } from "@tedix/db/queries/cognitive/skill-validation";
import type { FactoryBuildState } from "@tedix/db/queries/factories";
import { describe, expect, it } from "vite-plus/test";
import {
	buildFactory,
	factoryNameFromGoal,
	factorySlugFrom,
	type FactoryOwnerCandidate,
	type FactoryStore,
	resolveFactoryOwner,
	staggeredFactoryCron,
} from "./factory-builder";
import { renderFactoryLane } from "./factory-lane-template";

const OWNER = "8d0f3a52-1c7e-4e55-9a0d-5c1f0b6f2a11";

/** In-memory org: enough of D1 to prove a second build writes nothing. */
function memoryStore(canActivate: boolean) {
	const writes: string[] = [];
	let seq = 0;
	const id = (kind: string) => `${kind}-${++seq}`;
	const projects = new Map<
		string,
		{
			id: string;
			key: string;
			objectiveId: string | null;
			metadata: Record<string, JsonValue>;
		}
	>();
	const skills = new Map<
		string,
		{
			id: string;
			slug: string;
			lifecycleState: string;
			content: string;
			files: Record<string, string>;
		}
	>();
	const schedules = new Map<string, { cron: string; nextFireAt: string }>();
	const intents = new Map<string, string>();
	const store: FactoryStore = {
		canActivate,
		async load({ slug, projectKey }): Promise<FactoryBuildState> {
			const project =
				[...projects.values()].find(
					(row) =>
						(row.metadata.factory as { slug?: string } | undefined)?.slug ===
						slug,
				) ?? [...projects.values()].find((row) => row.key === projectKey);
			const skill = [...skills.values()].find((row) => row.slug === slug);
			const schedule = skill ? schedules.get(skill.id) : undefined;
			return {
				skill: skill
					? {
							id: skill.id,
							slug: skill.slug,
							title: skill.slug,
							tediId: OWNER,
							lifecycleState: skill.lifecycleState,
							revision: 1,
						}
					: null,
				schedule: schedule ? { ...schedule, enabled: true } : null,
				project: project
					? ({
							...project,
							orgId: "org",
							name: project.key,
							description: null,
							status: "active",
							leadTediId: OWNER,
							ownerUserId: null,
							targetDate: null,
							createdAt: "2026-10-15",
							updatedAt: null,
							archivedAt: null,
						} as FactoryBuildState["project"])
					: null,
				healthWorkItemId: intents.get(`factory:${slug}:health`) ?? null,
			};
		},
		callerTediId: null,
		async listOwnerCandidates() {
			return [
				{
					id: OWNER,
					slug: "nova",
					name: "nova",
					displayName: "Nova",
					createdAt: "2026-01-01 00:00:00",
					operator: true,
				},
			];
		},
		async workspaceExists() {
			return true;
		},
		async createObjective() {
			writes.push("objective");
			return id("objective");
		},
		async createProject(params) {
			writes.push("project");
			const row = {
				id: id("project"),
				key: params.key,
				objectiveId: params.objectiveId,
				metadata: params.metadata,
			};
			projects.set(row.id, row);
			return row;
		},
		async bindProject(params) {
			writes.push("bind");
			const row = projects.get(params.projectId)!;
			row.metadata = { ...row.metadata, ...params.metadata };
		},
		async createHealthItem(params) {
			writes.push("health");
			const itemId = id("work");
			intents.set(params.sourceIntentId, itemId);
			return itemId;
		},
		async createLaneSkill(params) {
			writes.push("skill");
			const row = {
				id: id("skill"),
				slug: params.slug,
				lifecycleState: "draft",
				content: params.content,
				files: params.files,
			};
			skills.set(row.id, row);
			return { id: row.id, lifecycleState: row.lifecycleState };
		},
		async activateLaneSkill(skillId) {
			writes.push("activate");
			const skill = skills.get(skillId)!;
			skill.lifecycleState = "active";
			const { schedule } = validateSkillSchedulePolicy(skill.content);
			schedules.set(skillId, {
				cron: schedule!.cron,
				nextFireAt: "2026-10-16T05:17:00.000Z",
			});
			return {
				lifecycleState: "active",
				nextFireAt: "2026-10-16T05:17:00.000Z",
			};
		},
	};
	return { store, writes, skills, projects };
}

const input = (extra: Record<string, unknown> = {}) =>
	CreateFactoryInputSchema.parse({
		goal: "Keep the public docs accurate against the shipped code.",
		ownerTedi: "Nova",
		...extra,
	});

describe("buildFactory", () => {
	it("creates every part once and is a no-op on the second call", async () => {
		const { store, writes, projects } = memoryStore(true);

		const first = await buildFactory(store, input({ name: "Docs accuracy" }));
		expect(first).toMatchObject({
			slug: "docs-accuracy",
			status: "created",
			projectKey: "DOCS-ACCURACY",
			skillLifecycleState: "active",
			nextFireAt: "2026-10-16T05:17:00.000Z",
			ownerTediId: OWNER,
		});
		expect(first.steps.map((step) => [step.resource, step.action])).toEqual([
			["objective", "created"],
			["project", "created"],
			["health_work_item", "created"],
			["skill", "created"],
			["schedule", "activated"],
		]);
		expect(writes).toEqual([
			"objective",
			"project",
			"health",
			"skill",
			"activate",
			"bind",
		]);
		const binding = [...projects.values()][0]!.metadata.factory as Record<
			string,
			unknown
		>;
		expect(binding).toMatchObject({
			slug: "docs-accuracy",
			skillId: first.skillId,
			healthWorkItemId: first.healthWorkItemId,
			objectiveId: first.objectiveId,
		});

		writes.length = 0;
		const second = await buildFactory(store, input({ name: "Docs accuracy" }));
		expect(writes).toEqual([]);
		expect(second.status).toBe("unchanged");
		expect(second.steps.every((step) => step.action === "reused")).toBe(true);
		for (const key of [
			"projectId",
			"objectiveId",
			"healthWorkItemId",
			"skillId",
			"cron",
			"nextFireAt",
		] as const) {
			expect(second[key]).toBe(first[key]);
		}
	});

	it("leaves an agent's lane a draft and names the proof step", async () => {
		const { store, writes } = memoryStore(false);
		const result = await buildFactory(store, input({ slug: "docs-lane" }));
		expect(writes).not.toContain("activate");
		expect(result).toMatchObject({
			skillLifecycleState: "draft",
			nextFireAt: null,
		});
		expect(result.nextActions[0]).toContain("probe: true");
		expect(result.nextActions[1]).toContain("improve_skills");
	});

	it("plans without writing on a dry run", async () => {
		const { store, writes } = memoryStore(true);
		const result = await buildFactory(store, input({ dryRun: true }));
		expect(writes).toEqual([]);
		expect(result.status).toBe("planned");
		expect(result.steps.every((step) => step.action === "would_create")).toBe(
			true,
		);
	});

	it("rejects an unknown owner tedi", async () => {
		const { store } = memoryStore(true);
		await expect(
			buildFactory(store, input({ ownerTedi: "nobody" })),
		).rejects.toThrow(
			/No active tedi "nobody".*Valid ownerTedi slugs: nova \(Nova\)/,
		);
	});

	it("defaults the owner when ownerTedi is omitted", async () => {
		const { store } = memoryStore(true);
		const result = await buildFactory(
			store,
			CreateFactoryInputSchema.parse({
				goal: "Keep the public docs accurate against the shipped code.",
				dryRun: true,
			}),
		);
		expect(result.ownerTediId).toBe(OWNER);
	});
});

describe("resolveFactoryOwner", () => {
	const tedi = (
		slug: string,
		extra: Partial<FactoryOwnerCandidate> = {},
	): FactoryOwnerCandidate => ({
		id: `id-${slug}`,
		slug,
		name: slug,
		displayName: null,
		createdAt: "2026-05-01 00:00:00",
		operator: false,
		...extra,
	});
	const roster = [
		tedi("scout", { createdAt: "2026-01-01 00:00:00" }),
		tedi("atlas", { displayName: "Atlas", operator: true }),
		tedi("writer", { displayName: "Writer" }),
	];

	it("maps omitted, home and default to the operator tedi", () => {
		for (const ref of [undefined, "home", "Home", "default"]) {
			expect(resolveFactoryOwner(ref, roster, null).id).toBe("id-atlas");
		}
	});

	it("falls back to the oldest tedi without an operator", () => {
		const plain = roster.map((row) => ({ ...row, operator: false }));
		expect(resolveFactoryOwner("home", plain, null).id).toBe("id-scout");
	});

	it("prefers the calling tedi when the owner is omitted or me", () => {
		expect(resolveFactoryOwner(undefined, roster, "id-writer").id).toBe(
			"id-writer",
		);
		expect(resolveFactoryOwner("me", roster, "id-writer").id).toBe("id-writer");
		expect(resolveFactoryOwner("home", roster, "id-writer").id).toBe(
			"id-atlas",
		);
	});

	it("matches id, slug and display name", () => {
		expect(resolveFactoryOwner("id-scout", roster, null).id).toBe("id-scout");
		expect(resolveFactoryOwner("WRITER", roster, null).id).toBe("id-writer");
		expect(resolveFactoryOwner("Atlas", roster, null).name).toBe("Atlas");
	});

	it("lets a tedi whose slug is an alias win", () => {
		const withHome = [...roster, tedi("home")];
		expect(resolveFactoryOwner("home", withHome, null).id).toBe("id-home");
	});

	it("lists the valid slugs and the default on a miss", () => {
		expect(() => resolveFactoryOwner("nobody", roster, null)).toThrow(
			'No active tedi "nobody" in this organization. Valid ownerTedi slugs: scout, atlas (Atlas), writer (Writer). Or omit ownerTedi to use the default tedi "atlas".',
		);
	});

	it("explains an empty roster", () => {
		expect(() => resolveFactoryOwner(undefined, [], null)).toThrow(
			/no active tedi/,
		);
	});
});

describe("factory naming and cadence", () => {
	it("derives a name and slug from the goal", () => {
		expect(factoryNameFromGoal("keep the docs accurate, always.")).toBe(
			"Keep the docs accurate",
		);
		expect(factorySlugFrom("Keep the docs accurate")).toBe(
			"keep-the-docs-accurate",
		);
	});

	it("staggers daily crons off :00 and :30, deterministically", () => {
		const slugs = Array.from({ length: 200 }, (_, i) => `factory-${i}`);
		for (const slug of slugs) {
			const cron = staggeredFactoryCron(slug, "daily");
			const [minute, hour, ...rest] = cron.split(" ");
			expect(Number(minute) % 30).not.toBe(0);
			expect(Number(hour)).toBeLessThan(24);
			expect(rest).toEqual(["*", "*", "*"]);
			expect(staggeredFactoryCron(slug, "daily")).toBe(cron);
		}
		expect(
			new Set(slugs.map((slug) => staggeredFactoryCron(slug, "daily"))).size,
		).toBeGreaterThan(100);
		expect(staggeredFactoryCron("docs", "twice_daily")).toMatch(
			/^\d+ \d+,\d+ \* \* \*$/,
		);
	});
});

// ---------------------------------------------------------------------------
// The rendered report lane
// ---------------------------------------------------------------------------

const LANE = renderFactoryLane("report", {
	slug: "docs-accuracy",
	name: "Docs accuracy",
	goal: 'Keep the "public" docs accurate.',
	cron: "17 5 * * *",
	ownerTediId: OWNER,
	projectId: "11111111-1111-4111-8111-111111111111",
	objectiveId: "22222222-2222-4222-8222-222222222222",
	healthWorkItemId: "33333333-3333-4333-8333-333333333333",
	workspaceId: null,
	maxProposals: 2,
});

type Lane = {
	run(
		event: { payload?: Record<string, unknown> },
		step: unknown,
		env: unknown,
	): Promise<Record<string, unknown>>;
};

function loadLane(): Lane {
	const source = LANE.files["scripts/workflow.ts"]!.replace(
		"export default {",
		"return {",
	);
	// Test-only evaluation of the generated module body.
	return new Function(source)() as Lane;
}

function laneHarness(reply: string | null) {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const tool =
		(name: string, result: (args: Record<string, unknown>) => unknown) =>
		async (args: Record<string, unknown>) => {
			calls.push([name, args]);
			return result(args);
		};
	const env = {
		__RUN_CONTEXT__: { runId: "run-1" },
		MCP: {
			tedi: {
				work_items_list: tool("work_items_list", () => ({
					data: [
						{
							id: "w-1",
							title: "Fix the install page",
							disposition: "proposed",
							sourceIntentId: null,
						},
					],
				})),
				run_tedi_turn: tool("run_tedi_turn", () => ({ pending: true })),
				messages_read: tool("messages_read", () => ({
					messages: [
						{ role: "user", content: "The marker line is: FACTORY_REPORT {}" },
						...(reply ? [{ role: "assistant", content: reply }] : []),
					],
				})),
				work_item_create: tool("work_item_create", (args) => ({
					id: `new-${String(args.title).length}`,
				})),
				work_item_comment: tool("work_item_comment", () => ({ ok: true })),
			},
		},
	};
	const step = {
		do: async (
			_name: string,
			configOrFn: unknown,
			maybeFn?: () => Promise<unknown>,
		) =>
			typeof configOrFn === "function"
				? (configOrFn as () => Promise<unknown>)()
				: maybeFn!(),
		sleep: async () => undefined,
	};
	return { calls, env, step };
}

describe("report lane template", () => {
	it("passes skill validation with a schedule and a tedi-only manifest", () => {
		const { schedule, issues } = validateSkillSchedulePolicy(LANE.content);
		expect(issues).toEqual([]);
		expect(schedule).toMatchObject({ cron: "17 5 * * *", enabled: true });
		const manifest = parseCapabilityManifest(LANE.content);
		expect(Object.keys(manifest.mcp)).toEqual(["tedi"]);
		expect(
			validateWorkflowSource(
				LANE.files["scripts/workflow.ts"]!,
				"scripts/workflow.ts",
				manifest as Parameters<typeof validateWorkflowSource>[2],
			),
		).toEqual([]);
	});

	it("probes without a turn or a write", async () => {
		const { calls, env, step } = laneHarness(null);
		const result = await loadLane().run(
			{ payload: { probe: true } },
			step,
			env,
		);
		expect(result).toMatchObject({ probe: true, projectWork: 1 });
		expect(calls.map(([name]) => name)).toEqual(["work_items_list"]);
	});

	it("files capped, deduplicated proposals and a scorecard", async () => {
		const reply = `Summary first.\nFACTORY_REPORT\n${JSON.stringify({
			summary: "Two gaps found.",
			proposals: [
				{ title: "Fix the install page", description: "dup", priority: "high" },
				{
					title: "Document factory health",
					description: "new",
					priority: "high",
				},
				{ title: "Document factory health", description: "dup in reply" },
			],
		})}`;
		const { calls, env, step } = laneHarness(reply);
		const result = await loadLane().run(
			{ payload: { cycleKey: "2026-10-15" } },
			step,
			env,
		);
		const creates = calls.filter(([name]) => name === "work_item_create");
		expect(creates).toHaveLength(1);
		expect(creates[0]![1]).toMatchObject({
			title: "Document factory health",
			projectId: "11111111-1111-4111-8111-111111111111",
			objectiveId: "22222222-2222-4222-8222-222222222222",
			sourceIntentId: "factory:docs-accuracy:proposal:document-factory-health",
			priority: "high",
		});
		expect(result).toMatchObject({ skipped: 1, cycleKey: "2026-10-15" });
		const [, comment] = calls.find(([name]) => name === "work_item_comment")!;
		expect(comment.id).toBe("33333333-3333-4333-8333-333333333333");
		expect(String(comment.body)).toContain("Proposed: 1 new Work Item");
	});

	it("fails after its scorecard when the owner never reports", async () => {
		const { calls, env, step } = laneHarness(null);
		await expect(
			loadLane().run({ payload: { cycleKey: "2026-10-15" } }, step, env),
		).rejects.toThrow(/no FACTORY_REPORT/);
		expect(calls.some(([name]) => name === "work_item_comment")).toBe(true);
		expect(calls.some(([name]) => name === "work_item_create")).toBe(false);
	});
});
