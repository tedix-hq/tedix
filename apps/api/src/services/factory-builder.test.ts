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
	factoryGoalLimits,
	factorySlugFrom,
	type FactoryOwnerCandidate,
	type FactoryStore,
	resolveFactoryOwner,
	staggeredFactoryCron,
	localFactoryCron,
} from "./factory-builder";
import { renderFactoryLane } from "./factory-lane-template";

const OWNER = "8d0f3a52-1c7e-4e55-9a0d-5c1f0b6f2a11";
const DOC_ID = "44444444-4444-4444-8444-444444444444";
const DECK_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";

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
	const workspaceLinks = new Set<string>();
	const skillLinks = new Map<string, string>();
	const outputs = [
		{ id: DOC_ID, title: "Weekly notes", kind: "document" },
		{ id: DECK_ID, title: "Pitch", kind: "presentation" },
	];
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
							content: skill.content,
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
		async linkWorkspaceProject({ workspaceId, projectId }) {
			const key = `${workspaceId}:${projectId}`;
			if (workspaceLinks.has(key)) return { created: false };
			writes.push("workspace");
			workspaceLinks.add(key);
			return { created: true };
		},
		async linkWorkspaceSkill({ workspaceId, skillId, name }) {
			const key = `${workspaceId}:${skillId}`;
			if (skillLinks.has(key)) return { created: false };
			writes.push("workspace_skill");
			skillLinks.set(key, name);
			return { created: true };
		},
		async findOutputById(outputId) {
			return outputs.find((row) => row.id === outputId) ?? null;
		},
		async findOutputByTitle(params) {
			return (
				outputs.find(
					(row) =>
						row.title.toLowerCase() === params.title.toLowerCase() &&
						row.kind === params.kind,
				) ?? null
			);
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
	return { store, writes, skills, projects, workspaceLinks, skillLinks };
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
			ownerTediName: "Nova",
			warnings: [],
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

	it("links the project to the Workspace once, so its Work view lists the factory", async () => {
		const { store, workspaceLinks, skillLinks } = memoryStore(true);
		const planned = await buildFactory(
			store,
			input({ slug: "linked", workspaceId: WORKSPACE, dryRun: true }),
		);
		expect(planned.steps).toContainEqual({
			resource: "workspace",
			action: "would_create",
			id: WORKSPACE,
		});
		expect(workspaceLinks.size).toBe(0);
		expect(skillLinks.size).toBe(0);

		const first = await buildFactory(
			store,
			input({ slug: "linked", workspaceId: WORKSPACE }),
		);
		expect(first.steps).toContainEqual({
			resource: "workspace",
			action: "linked",
			id: WORKSPACE,
		});
		expect(first.steps).toContainEqual({
			resource: "workspace",
			action: "linked",
			id: WORKSPACE,
			note: "lane skill listed under Skills and schedules",
		});
		expect([...workspaceLinks]).toEqual([`${WORKSPACE}:${first.projectId}`]);
		expect([...skillLinks]).toEqual([
			[`${WORKSPACE}:${first.skillId}`, "Keep the public docs factory"],
		]);

		const again = await buildFactory(store, input({ slug: "linked" }));
		expect(again.status).toBe("unchanged");
		expect(again.steps).toContainEqual({
			resource: "workspace",
			action: "reused",
			id: WORKSPACE,
		});
		expect(again.steps).toContainEqual({
			resource: "workspace",
			action: "reused",
			id: WORKSPACE,
			note: "lane skill listed under Skills and schedules",
		});
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
		expect(result.ownerTediName).toBe("Nova");
		expect(result.warnings).toEqual([]);
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
	cadence: "daily",
	output: null,
});

type Lane = {
	run(
		event: { payload?: Record<string, unknown> },
		step: unknown,
		env: unknown,
	): Promise<Record<string, unknown>>;
};

function loadLane(lane = LANE): Lane {
	const source = lane.files["scripts/workflow.ts"]!.replace(
		"export default {",
		"return {",
	);
	// Test-only evaluation of the generated module body.
	return new Function(source)() as Lane;
}

function laneHarness(
	reply: string | null,
	os: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
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
				work_item_get: tool("work_item_get", () => ({ comments: [] })),
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
			os: Object.fromEntries(
				Object.entries(os).map(([name, result]) => [name, tool(name, result)]),
			),
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

describe("local factory schedules", () => {
	it("covers both Berlin UTC offsets and writes the local slots to the skill and resource", async () => {
		const runsAt = { timeZone: "Europe/Berlin", times: ["08:30"] };
		expect(localFactoryCron(runsAt)).toBe("30 6,7 * * *");
		const { store, skills } = memoryStore(true);
		let linked: unknown;
		const link = store.linkWorkspaceSkill;
		store.linkWorkspaceSkill = async (params) => {
			linked = params;
			return link(params);
		};
		const result = await buildFactory(
			store,
			input({ runsAt, workspaceId: WORKSPACE }),
		);
		expect(result.cron).toBe("30 6,7 * * *");
		expect(linked).toMatchObject({ runsAt });
		const lane = [...skills.values()][0]!;
		expect(lane.content).toContain(
			'runsAt: {"timeZone":"Europe/Berlin","times":["08:30"]}',
		);
		const { env, calls } = laneHarness(null);
		const source = lane.files["scripts/workflow.ts"]!.replace(
			"export default {",
			"return {",
		);
		const rendered = new Function(source)() as Lane;
		const fixedStep = {
			do: async (name: string, fn: () => unknown) =>
				name === "started-at" ? "2026-07-01T07:30:00Z" : fn(),
		};
		expect(await rendered.run({}, fixedStep, env)).toEqual({
			status: "off_slot",
		});
		expect(calls).toEqual([]);
		await buildFactory(store, input({ workspaceId: WORKSPACE }));
		expect(linked).toMatchObject({ runsAt });
		const probe = await rendered.run(
			{ payload: { probe: true } },
			{
				...fixedStep,
				do: async (
					name: string,
					optionsOrFn: unknown,
					maybeFn?: () => unknown,
				) =>
					name === "started-at"
						? "2026-07-01T06:30:00Z"
						: typeof optionsOrFn === "function"
							? optionsOrFn()
							: maybeFn!(),
			},
			env,
		);
		expect(probe).toMatchObject({ probe: true });
		expect(calls.map(([name]) => name)).toEqual(["work_items_list"]);
	});
	it("rejects unknown time zones", () => {
		expect(() =>
			localFactoryCron({ timeZone: "Mars/Olympus", times: ["08:30"] }),
		).toThrow("IANA time zone");
	});
});

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

	it("hands recent comments to the owner newest first and keeps manual cycles distinct", async () => {
		const { calls, env, step } = laneHarness(
			'FACTORY_REPORT {"summary":"Read comments.","proposals":[]}',
		);
		const since = "2026-10-15T10:00:00.000Z";
		env.MCP.tedi.work_item_get = async ({ id }) => ({
			comments:
				id === "33333333-3333-4333-8333-333333333333"
					? [
							{
								metadata: {
									factory: "docs-accuracy",
									startedAt: since,
									ownerReplyReceived: true,
								},
							},
						]
					: [
							{
								id: "old",
								createdAt: "2026-10-14T00:00:00.000Z",
								body: "Already reported",
							},
							...Array.from({ length: 12 }, (_, i) => ({
								id: `c-${i}`,
								createdAt: `2026-10-15T11:${String(i).padStart(2, "0")}:00.000Z`,
								authorType: "tedi",
								authorId: "nova",
								body: i === 11 ? "x".repeat(2001) : `Update ${i}`,
							})),
							{
								id: "future",
								createdAt: "2099-01-01T00:00:00.000Z",
								body: "After snapshot",
							},
						],
		});
		for (const cycleKey of ["manual-a", "manual-b"]) {
			await loadLane().run({ payload: { cycleKey } }, step, env);
		}
		const turns = calls
			.filter(([name]) => name === "run_tedi_turn")
			.map(([, args]) => args);
		expect(turns.map((turn) => turn.session_key)).toEqual([
			"factory:docs-accuracy:manual-a",
			"factory:docs-accuracy:manual-b",
		]);
		expect(turns[0]!.client_request_id).not.toBe(turns[1]!.client_request_id);
		const text = String(turns[0]!.text);
		expect(text).toContain("id w-1");
		expect(text).toContain("2026-10-15T11:11:00.000Z by tedi:nova");
		expect(text).toContain("[truncated]");
		expect(text).toContain("2 more recent comments omitted");
		expect(text.indexOf("Update 10")).toBeLessThan(text.indexOf("Update 9"));
		expect(text).not.toContain("Already reported");
		expect(text).not.toContain("After snapshot");
		expect(text).not.toContain('"Update 1"');
		const scorecard = calls.find(([name]) => name === "work_item_comment")![1];
		expect(scorecard.metadata).toMatchObject({
			factory: "docs-accuracy",
			ownerReplyReceived: true,
		});
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
			sourceIntentId:
				"factory-lane:docs-accuracy:proposal:document-factory-health",
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

describe("factoryGoalLimits", () => {
	it.each(["hourly", "every hour", "every 2 hours", "per hour"])(
		"names the hourly cadence for: %s",
		(cadence) => {
			const notes = factoryGoalLimits(`Review Work ${cadence}.`);
			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain('cadence: "hourly"');
			expect(notes[0]).toContain("--every-hours");
		},
	);

	it("is quiet when the cadence is already hourly", () => {
		expect(
			factoryGoalLimits("Review Work every hour.", {
				cadence: "hourly",
				output: null,
			}),
		).toEqual([]);
	});

	it("names the hourly ceiling for minute schedules", () => {
		const notes = factoryGoalLimits("Review Work every 15 minutes.", {
			cadence: "hourly",
			output: null,
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("at most hourly");
	});

	it.each([
		"Write findings into the document.",
		"Append a report to our sheet.",
		"Publish the summary to an Output.",
		"Write results to a page.",
		"Write notes into a doc.",
	])("names the output option for: %s", (goal) => {
		const notes = factoryGoalLimits(goal);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("--output");
		expect(
			factoryGoalLimits(goal, { cadence: "daily", output: "Notes" }),
		).toEqual([]);
	});

	it("says Notion pages are out of reach", () => {
		const notes = factoryGoalLimits("Update results to Notion.", {
			cadence: "daily",
			output: "Notes",
		});
		expect(notes).toEqual([
			"The report lane writes only Tedix document and sheet Outputs, not Notion pages.",
		]);
	});

	it("does not infer document writes from a docs maintenance goal", () => {
		expect(
			factoryGoalLimits("Keep the docs accurate against the code."),
		).toEqual([]);
	});

	it.each([true, false])(
		"returns owner and both warnings on builds (dryRun: %s)",
		async (dryRun) => {
			const { store } = memoryStore(true);
			const goal = "Write findings into the document every hour.";
			const result = await buildFactory(store, input({ goal, dryRun }));
			expect(result.ownerTediName).toBe("Nova");
			expect(result.warnings).toEqual(factoryGoalLimits(goal));
			expect(result.warnings).toHaveLength(2);
		},
	);
});

describe("hourly cadence", () => {
	it("renders hourly and every-N-hours crons off :00 and :30", () => {
		const hourly = staggeredFactoryCron("docs", "hourly");
		expect(hourly).toMatch(/^\d+ \* \* \* \*$/);
		const minute = Number(hourly.split(" ")[0]);
		expect(minute % 30).not.toBe(0);
		const every6 = staggeredFactoryCron("docs", "hourly", 6);
		const hours = every6.split(" ")[1]!.split(",").map(Number);
		expect(hours).toHaveLength(4);
		expect(
			hours.every((hour, i) => i === 0 || hour - hours[i - 1]! === 6),
		).toBe(true);
		expect(every6.split(" ")[0]).toBe(String(minute));
	});

	it("builds an hourly lane and records the step", async () => {
		const { store, projects } = memoryStore(true);
		const result = await buildFactory(
			store,
			input({ cadence: "hourly", everyHours: 3 }),
		);
		expect(result.cron.split(" ")[1]!.split(",")).toHaveLength(8);
		const binding = [...projects.values()][0]!.metadata.factory as Record<
			string,
			unknown
		>;
		expect(binding).toMatchObject({ cadence: "hourly", everyHours: 3 });
	});

	it("rejects everyHours without the hourly cadence", async () => {
		const { store } = memoryStore(true);
		await expect(buildFactory(store, input({ everyHours: 2 }))).rejects.toThrow(
			/needs cadence "hourly"/,
		);
		expect(() => input({ cadence: "hourly", everyHours: 5 })).toThrow();
	});
});

describe("factory output", () => {
	it("binds an Output by id and lists only its tools", async () => {
		const { store, skills } = memoryStore(true);
		const result = await buildFactory(store, input({ output: DOC_ID }));
		expect(result.output).toEqual({
			id: DOC_ID,
			title: "Weekly notes",
			kind: "document",
		});
		expect(result.steps).toContainEqual({
			resource: "output",
			action: "reused",
			id: DOC_ID,
		});
		const skill = [...skills.values()][0]!;
		expect(skill.content).toContain("os: [get_os_output, patch_os_document]");
		expect(skill.files["scripts/workflow.ts"]).toContain(DOC_ID);
	});

	it("finds a title in the Workspace, else leaves it to the first run", async () => {
		const { store } = memoryStore(true);
		const found = await buildFactory(
			store,
			input({ slug: "found", output: "weekly NOTES", workspaceId: WORKSPACE }),
		);
		expect(found.output?.id).toBe(DOC_ID);
		const planned = await buildFactory(
			store,
			input({
				slug: "planned",
				output: "Run log",
				outputKind: "sheet",
				workspaceId: WORKSPACE,
			}),
		);
		expect(planned.output).toEqual({
			id: null,
			title: "Run log",
			kind: "sheet",
		});
		expect(planned.steps).toContainEqual(
			expect.objectContaining({ resource: "output", action: "would_create" }),
		);
	});

	it("rejects a title without a Workspace and a non-document id", async () => {
		const { store } = memoryStore(true);
		await expect(
			buildFactory(store, input({ output: "Run log" })),
		).rejects.toThrow(/needs workspaceId/);
		await expect(
			buildFactory(store, input({ output: DECK_ID })),
		).rejects.toThrow(/document or a sheet/);
		await expect(
			buildFactory(store, input({ outputKind: "sheet" })),
		).rejects.toThrow(/outputKind needs output/);
	});

	it("warns instead of changing an existing lane's output", async () => {
		const { store } = memoryStore(true);
		await buildFactory(store, input());
		const again = await buildFactory(store, input({ output: DOC_ID }));
		expect(again.output).toBeNull();
		expect(again.warnings.join(" ")).toContain("stay as built");
	});
});

const OUTPUT_LANE_PARAMS = {
	slug: "comment-digest",
	name: "Comment digest",
	goal: "Summarize new comments every hour.",
	cron: "17 * * * *",
	ownerTediId: OWNER,
	projectId: "11111111-1111-4111-8111-111111111111",
	objectiveId: "22222222-2222-4222-8222-222222222222",
	healthWorkItemId: "33333333-3333-4333-8333-333333333333",
	workspaceId: WORKSPACE,
	maxProposals: 0,
	cadence: "hourly" as const,
};

const DIGEST_REPLY = `Done.\nFACTORY_REPORT\n${JSON.stringify({
	summary: "Two new comments on the install page.",
	proposals: [],
})}`;

describe("report lane with an Output", () => {
	it("passes validation with the os tools in its manifest", () => {
		const lane = renderFactoryLane("report", {
			...OUTPUT_LANE_PARAMS,
			output: { id: null, title: "Comment digest", kind: "document" },
		});
		const manifest = parseCapabilityManifest(lane.content);
		expect(manifest.mcp.os).toEqual([
			"list_os_outputs",
			"create_os_output",
			"get_os_output",
			"patch_os_document",
		]);
		expect(
			validateWorkflowSource(
				lane.files["scripts/workflow.ts"]!,
				"scripts/workflow.ts",
				manifest as Parameters<typeof validateWorkflowSource>[2],
			),
		).toEqual([]);
	});

	it("creates the document on the first run, appends a dated section, and skips a repeat", async () => {
		const lane = renderFactoryLane("report", {
			...OUTPUT_LANE_PARAMS,
			output: { id: null, title: "Comment digest", kind: "document" },
		});
		let blocks: Array<Record<string, unknown>> = [];
		const os = {
			list_os_outputs: () => ({ items: [], truncated: false }),
			create_os_output: () => ({ output: { id: DOC_ID } }),
			get_os_output: () => ({
				output: { id: DOC_ID },
				currentRevision: {
					revision: 1 + blocks.length,
					content: { kind: "document", blocks },
				},
			}),
			patch_os_document: (args: Record<string, unknown>) => {
				for (const op of args.ops as Array<{ block: Record<string, unknown> }>)
					blocks = [...blocks, op.block];
				return { output: { id: DOC_ID } };
			},
		};
		const first = laneHarness(DIGEST_REPLY, os);
		const result = await loadLane(lane).run({}, first.step, first.env);
		expect(String(result.cycleKey)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
		expect(result.output).toEqual({ outputId: DOC_ID, written: true });
		const [, create] = first.calls.find(
			([name]) => name === "create_os_output",
		)!;
		expect(create).toMatchObject({
			kind: "document",
			title: "Comment digest",
			workspaceId: WORKSPACE,
		});
		const [, patch] = first.calls.find(
			([name]) => name === "patch_os_document",
		)!;
		expect(patch).toMatchObject({ outputId: DOC_ID, expectedRevision: 1 });
		expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
		expect(String(blocks[0]!.text)).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
		);
		expect(blocks[1]).toEqual({
			type: "paragraph",
			text: "Two new comments on the install page.",
		});
		expect(blocks.at(-1)!.text).toBe("Comment digest factory, run run-1");
		const [, prompt] = first.calls.find(([name]) => name === "run_tedi_turn")!;
		expect(String(prompt.text)).toContain("Do not propose Work Items");
		expect(String(prompt.text)).toContain("Fix the install page (id w-1)");

		// A retried run finds its own section and writes nothing.
		const retry = laneHarness(DIGEST_REPLY, {
			...os,
			list_os_outputs: () => ({
				items: [{ id: DOC_ID, title: "comment digest" }],
				truncated: false,
			}),
		});
		const again = await loadLane(lane).run({}, retry.step, retry.env);
		expect(again.output).toEqual({ outputId: DOC_ID, written: false });
		expect(retry.calls.some(([name]) => name === "create_os_output")).toBe(
			false,
		);
		expect(retry.calls.some(([name]) => name === "patch_os_document")).toBe(
			false,
		);
		const [, scorecard] = retry.calls.find(
			([name]) => name === "work_item_comment",
		)!;
		expect(String(scorecard.body)).toContain("already had this run's section");
	});

	it("appends one row to a bound sheet", async () => {
		const lane = renderFactoryLane("report", {
			...OUTPUT_LANE_PARAMS,
			output: { id: DOC_ID, title: "Run log", kind: "sheet" },
		});
		const { calls, env, step } = laneHarness(DIGEST_REPLY, {
			get_os_output: () => ({
				currentRevision: {
					revision: 4,
					content: {
						kind: "sheet",
						columns: ["When", "Notes", "Run"],
						rows: [["2026-10-15 09:17 UTC", "Quiet hour.", "older run"]],
					},
				},
			}),
			set_os_sheet_range: () => ({ output: { id: DOC_ID } }),
		});
		await loadLane(lane).run({}, step, env);
		const [, range] = calls.find(([name]) => name === "set_os_sheet_range")!;
		expect(range).toMatchObject({
			outputId: DOC_ID,
			startRow: 1,
			startColumn: 0,
			expectedRevision: 4,
		});
		const [row] = range.cells as string[][];
		expect(row).toHaveLength(3);
		expect(row![1]).toBe("Two new comments on the install page.");
		expect(row![2]).toBe("Comment digest factory, run run-1");
	});
});
