import type { RuntimeInferenceOrigin } from "../../src/runtime-inference-origin";
import { env } from "cloudflare:workers";
import {
	abortAllDurableObjects,
	runInDurableObject,
	runDurableObjectAlarm,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vite-plus/test";
import type { SessionMessage } from "agents/sessions";
import type { PiConversationFixture, ConversationStats } from "./worker";
const fixture = (name: string) =>
	getAgentByName(
		(
			env as unknown as {
				PI_CONVERSATION: DurableObjectNamespace<PiConversationFixture>;
			}
		).PI_CONVERSATION,
		name,
	);
async function inspect(agent: Awaited<ReturnType<typeof fixture>>) {
	return JSON.parse(await agent.inspectFixture()) as {
		stats: ConversationStats;
	};
}
async function waitForApproval(agent: Awaited<ReturnType<typeof fixture>>) {
	for (let n = 0; n < 100; n++) {
		const pending = await agent.pendingToolApprovals();
		if (pending[0]) return pending[0];
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("durable approval never paused");
}
describe("Production ConversationFacet on native Pi", () => {
	it("returns only its owned durable answer after eviction and duplicate input", async () => {
		const name = crypto.randomUUID();
		const agent = await fixture(name);
		const first = await agent.turn("first");
		await agent.turn("second");
		await abortAllDurableObjects();
		const restart = await fixture(name);
		expect(await restart.turn("first")).toEqual(first);
		expect((await inspect(restart)).stats).toMatchObject({
			requests: 2,
			reservations: 2,
			receipts: 2,
			effects: 0,
		});
	});
	it("records the provider and model on each Pi step receipt", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.turn("identity");
		const [step] = ((await inspect(agent)).stats.modelSteps ?? []) as Array<{
			provider: unknown;
			model: unknown;
			usage: { cacheReadTokens: unknown; cacheWriteTokens: unknown };
			autoRouter?: unknown;
		}>;
		// The turn's real selection, not Pi's stable `tedix/selected` catalog entry.
		expect(step?.provider).toBe("workers-ai");
		expect(step?.model).toBe("@cf/test");
		expect(step?.usage.cacheReadTokens).toEqual(expect.any(Number));
		expect(step?.usage.cacheWriteTokens).toEqual(expect.any(Number));
		// The Auto Router's concrete choice reaches the receipt from the finish part.
		expect(step?.autoRouter).toEqual({
			routedModel: "@cf/routed-test",
			routingReason: "fixture-route",
			routingDecisionId: "decision-1",
			requestId: null,
		});
	});
	it("honors the configured ceiling and persists a tools-off final report", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.setup("tool");
		await agent.enableFacetTool();
		const turn = await agent.turn("ceiling", { maxSteps: 1 });
		expect(turn.result.stopReason).toBe("step_ceiling");
		expect(turn.result.assistantText).toContain("Partial results above");
		const view = await inspect(agent);
		expect(view.stats).toMatchObject({
			requests: 2,
			effects: 0,
			reservations: 2,
			receipts: 2,
		});
		expect(view.stats.toolChoices).toEqual([
			{ type: "none" },
			{ type: "none" },
		]);
	});
	it("pauses before effects and approval resumes exactly one native tool", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.setup("tool");
		const running = agent.turn("approved", { approval: true });
		const approval = await waitForApproval(agent);
		expect((await inspect(agent)).stats.effects).toBe(0);
		await agent.resolveToolApproval({
			approvalId: approval.approvalId,
			approved: true,
		});
		const answer = await running;
		expect(answer.result.assistantText).toContain("owned answer");
		expect((await inspect(agent)).stats).toMatchObject({
			requests: 2,
			effects: 1,
			reservations: 2,
			receipts: 2,
		});
	});
	it("rejected approval cannot dispatch an effect", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.setup("tool");
		const running = agent.turn("rejected", { approval: true });
		const approval = await waitForApproval(agent);
		await agent.resolveToolApproval({
			approvalId: approval.approvalId,
			approved: false,
		});
		await running;
		expect((await inspect(agent)).stats.effects).toBe(0);
	});
	it("cancellation fences inference and cannot produce a successful answer", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.setup("stall");
		const running = agent.turn("cancelled").then(
			() => null,
			(error) => String(error),
		);
		for (let n = 0; n < 100 && (await inspect(agent)).stats.requests === 0; n++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await agent.cancelFixture();
		expect(await running).toMatch(/aborted|cancelled/);
		expect((await inspect(agent)).stats.requests).toBe(1);
	});
});

it("native compaction preserves exact protected head tool groups, last20 and repeated context", async () => {
	const agent = await fixture(crypto.randomUUID());
	await agent.setup("tool");
	await agent.enableFacetTool();
	await agent.turn("head");
	await agent.setup("text");
	await agent.seedCompactionEntries();
	expect(await agent.seedReadEvidenceFixture()).toBe(true);
	await agent.compactFixture();
	expect(JSON.parse(await agent.staleReadEvidenceFixture())).toMatchObject({
		ok: false,
	});
	await agent.turn("after-first");
	const first = JSON.stringify((await inspect(agent)).stats.prompts.at(-1));
	expect(first.includes("input head")).toBe(true);
	expect(first.includes("fixture-call:head")).toBe(true);
	for (let index = 12; index < 32; index++)
		expect(first.split(`retained-row-${index}:`).length - 1).toBe(1);
	const summary = await agent.summaryFixture();
	expect(summary).not.toContain("input head");
	expect(summary).not.toContain("fixture-call:head");
	expect(summary).not.toContain("retained-row-31:");
	await agent.seedCompactionEntries(32, 32);
	await agent.compactFixture();
	await agent.turn("after-second");
	const second = JSON.stringify((await inspect(agent)).stats.prompts.at(-1));
	expect(second).toContain("input head");
	expect(second).toContain("fixture-call:head");
	for (let index = 44; index < 64; index++)
		expect(second.split(`retained-row-${index}:`).length - 1).toBe(1);
	await agent.turn("fresh", { freshHistory: true });
	await agent.seedCompactionEntries(32, 64);
	await agent.compactFixture();
	await agent.turn("after-fresh");
	const fresh = JSON.stringify((await inspect(agent)).stats.prompts.at(-1));
	expect(fresh).not.toContain("input head");
	expect(fresh).not.toContain("fixture-call:head");
	expect(fresh).toContain("input fresh");
});
it("resumed native snapshot observes approval and drains the owned receipt", async () => {
	const agent = await fixture(crypto.randomUUID());
	await agent.setup("tool");
	const first = agent.turn("resume", { approval: true });
	const approval = await waitForApproval(agent);
	const stream = await agent.resumeConfiguredConversationTurn("resume");
	expect(stream).not.toBeNull();
	const frames = stream ? new Response(stream).text() : Promise.resolve("");
	await agent.resolveToolApproval({
		approvalId: approval.approvalId,
		approved: true,
	});
	const result = await first;
	const wire = await frames;
	expect(wire).toContain("data-pi-snapshot");
	expect(wire).toContain("tool-approval-request");
	const parsed = wire
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { kind: string; text?: string });
	expect(parsed.at(-1)).toMatchObject({
		kind: "done",
		text: result.result.assistantText,
	});
	expect((await inspect(agent)).stats.effects).toBe(1);
});

it("approval survives eviction without a duplicated effect or provider receipt", async () => {
	const name = crypto.randomUUID();
	const agent = await fixture(name);
	await agent.setup("tool");
	const interrupted = agent.turn("evicted-approval", { approval: true }).then(
		(value) => ({ value }),
		(error) => ({ error: String(error) }),
	);
	const approval = await waitForApproval(agent);
	await abortAllDurableObjects();
	await interrupted;
	const restart = await fixture(name);
	expect((await inspect(restart)).stats.effects).toBe(0);
	await restart.resolveToolApproval({
		approvalId: approval.approvalId,
		approved: true,
	});
	const result = await restart.turn("evicted-approval", { approval: true });
	expect(result.result.assistantText).toContain("owned answer");
	expect((await inspect(restart)).stats).toMatchObject({
		requests: 2,
		effects: 1,
		receipts: 2,
	});
});
it("regeneration forks before exact admitted input and keeps authored UI identity", async () => {
	const name = crypto.randomUUID();
	const agent = await fixture(name);
	const original = await agent.turn("branch-original");
	const changed = await agent.regenerate(
		"branch-original",
		"branch-replacement",
	);
	expect(changed.result.assistantText).not.toBe(original.result.assistantText);
	const prompt = JSON.stringify((await inspect(agent)).stats.prompts.at(-1));
	expect(prompt.split("input branch-original").length - 1).toBe(1);
	expect(prompt).not.toContain(original.result.assistantText);
	const history = JSON.parse(
		await agent.legacyHistoryJson(),
	) as SessionMessage[];
	expect(history.filter((message) => message.role === "user")).toMatchObject([
		{
			id: "ui:branch-original",
			parts: [{ type: "text", text: "authored branch-original" }],
		},
	]);
	await abortAllDurableObjects();
	expect(JSON.parse(await (await fixture(name)).legacyHistoryJson())).toEqual(
		history,
	);
});

it("passively imports populated legacy tools and URL/private images across later turns and eviction", async () => {
	const name = crypto.randomUUID();
	const agent = await fixture(name);
	await agent.seedLegacyHistory();
	await agent.turn("after-legacy");
	let view = await inspect(agent);
	expect(view.stats.requests).toBe(1);
	let prompt = JSON.stringify(view.stats.prompts.at(-1));
	expect(prompt).toContain("retained legacy context");
	expect(prompt).toContain("retained legacy answer");
	expect(prompt).toContain("legacy-owned-tool");
	expect(prompt).toContain("https://images.example.test/original.png");
	expect(prompt).toContain('"0":104');
	await abortAllDurableObjects();
	const restarted = await fixture(name);
	await restarted.turn("future-legacy");
	view = await inspect(restarted);
	expect(view.stats.requests).toBe(2);
	prompt = JSON.stringify(view.stats.prompts.at(-1));
	expect(prompt).toContain("https://images.example.test/original.png");
	expect(prompt).toContain('"0":104');
	const history = JSON.parse(
		await restarted.legacyHistoryJson(),
	) as SessionMessage[];
	expect(history.find((message) => message.id === "legacy-user")).toBeDefined();
	expect(
		history.find((message) => message.id === "legacy-answer"),
	).toBeDefined();
});
it("blocks activation for an actual pending legacy submission", async () => {
	const name = crypto.randomUUID();
	const agent = await fixture(name);
	await agent.seedLegacyPending();
	await abortAllDurableObjects();
	await expect(fixture(name)).rejects.toThrow(/Legacy Think|Pending Think/);
});

it("denies a fourth cold resumption of the same unfinished native tool without real progress", async () => {
	const name = crypto.randomUUID();
	let agent = await fixture(name);
	await agent.setup("tool");
	let running = agent.turn("recovery-cap", { approval: true }).then(
		(value) => ({ value }),
		(error) => ({ error: String(error) }),
	);
	await waitForApproval(agent);
	for (let cold = 1; cold <= 4; cold++) {
		await abortAllDurableObjects();
		await running;
		agent = await fixture(name);
		running = agent.turn("recovery-cap", { approval: true }).then(
			(value) => ({ value }),
			(error) => ({ error: String(error) }),
		);
		for (let n = 0; n < 100; n++) {
			const recovery = JSON.parse(await agent.recoveryFixture()) as {
				budgets: { count: number }[];
				blocked: string | null;
			};
			if (
				cold === 4
					? recovery.blocked !== null
					: recovery.budgets.some((row) => row.count === cold)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const recovery = JSON.parse(await agent.recoveryFixture()) as {
			budgets: { count: number }[];
			blocked: string | null;
		};
		if (cold < 4)
			expect(recovery.budgets.some((row) => row.count === cold)).toBe(true);
		else expect(recovery.blocked).toBe("recovery-cap");
	}
	await abortAllDurableObjects();
	await running;
});

it("maps Tedix Azure overflow to native compaction rather than transient retries", async () => {
	const agent = await fixture(crypto.randomUUID());
	await agent.turn("overflow-head");
	await agent.seedCompactionEntries();
	await agent.setup("overflow");
	const result = await agent.turn("overflow-backstop");
	expect(result.result.assistantText).toContain("owned answer");
	expect((await inspect(agent)).stats).toMatchObject({
		requests: 3,
		reservations: 3,
		receipts: 3,
	});
	expect(await agent.summaryFixture()).toContain("retained-row-");
});

describe("Production tool-free facets on native Pi", () => {
	for (const kind of ["judge", "synthesis"] as const) {
		it(
			kind +
				" preserves model pin, tools-off options and exact answers across later turns and eviction",
			async () => {
				const name = crypto.randomUUID();
				const bindings = env as unknown as {
					PI_JUDGE: DurableObjectNamespace<import("./worker").PiJudgeFixture>;
					PI_SYNTHESIS: DurableObjectNamespace<
						import("./worker").PiSynthesisFixture
					>;
				};
				const open = () =>
					kind === "judge"
						? getAgentByName(bindings.PI_JUDGE, name)
						: getAgentByName(bindings.PI_SYNTHESIS, name);
				let agent = await open();
				const first = await agent.turn("first");
				expect(first.assistantText).toBe(kind + "-model:first");
				expect(first.modelIdentity).toEqual({
					provider: "workers-ai",
					model: "@cf/" + kind + "-model",
				});
				expect(first.turnCount).toBe(1);
				const second = await agent.turn("second");
				expect(second.assistantText).toBe(kind + "-model:second");
				expect(second.turnCount).toBe(2);
				if (kind === "synthesis")
					expect(second).toHaveProperty("usage.totalTokens", 5);
				await abortAllDurableObjects();
				agent = await open();
				expect(await agent.turn("first")).toEqual(first);
				expect(await agent.alteredInput("first", "changed input")).toContain(
					"input changed",
				);
				const view = JSON.parse(await agent.inspectToolFree()) as {
					conversationId: number;
					stats: import("./worker").ToolFreeStats;
					history: SessionMessage[];
				};
				expect(view.conversationId).toBe(1);
				expect(view.stats.requests).toBe(2);
				expect(view.stats.reservations).toHaveLength(2);
				expect(view.stats.receipts).toHaveLength(2);
				expect(view.stats.toolChoices).toEqual([
					{ type: "none" },
					{ type: "none" },
				]);
				expect(view.stats.tools).toEqual([[], []]);
				expect(
					view.history
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.parts
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
						),
				).toEqual([kind + "-model:first", kind + "-model:second"]);
			},
		);
	}
});

describe("registered facet admission", () => {
	const selected = (name: string) =>
		getAgentByName(
			(
				env as unknown as {
					PI_ADMISSION_PARENT: DurableObjectNamespace<
						import("./worker").PiAdmissionParentFixture
					>;
				}
			).PI_ADMISSION_PARENT,
			name,
		);
	it("retains actual original root and selected accepted leaf custody across native turn execution", async () => {
		const parent = await selected(crypto.randomUUID());
		await parent.admittedTurn("private-origin-positive");
		const { origin, stats } = (await parent.privateOriginProbe()) as {
			origin: RuntimeInferenceOrigin;
			stats: ConversationStats;
		};
		expect(origin.kind).toBe("accepted_native");
		if (origin.kind !== "accepted_native")
			throw new Error("Expected accepted native origin");
		expect(origin.root.owner.objectId).toBe(parent.id.toString());
		expect(origin.selected.owner.objectId).not.toBe(origin.root.owner.objectId);
		expect(origin.root.accepted.runId).toBe("private-origin-positive");
		expect(origin.selected.accepted.runId).toBe("private-origin-positive");
		expect(origin.root.generation).toBe(origin.root.accepted.generation);
		expect(origin.selected.generation).toBe(
			origin.selected.accepted.generation,
		);
		expect(origin.selected.path.at(-1)).toEqual({
			className: "ConversationFacet",
			name: "admitted",
		});
		expect(stats.requests).toBeGreaterThan(0);
		expect(JSON.stringify(origin)).not.toContain(
			"input private-origin-positive",
		);
	});
	for (const mutation of [
		"configuration",
		"journal",
		"input",
		"path",
		"owner",
		"generation",
	])
		it(`refuses ${mutation} changed after native capture before scripted provider dispatch`, async () => {
			const parent = await selected(crypto.randomUUID());
			await parent.setOriginMutation(mutation);
			await parent.admittedTurn(`private-origin-${mutation}`);
			const probe = (await parent.privateOriginProbe()) as {
				origin: unknown;
				denial: unknown;
				stats: ConversationStats;
			};
			expect(probe.origin).toBeTruthy();
			expect(probe.denial).toEqual({
				denied: true,
				name: "ProviderDispatchGuardError",
				phase: "before_dispatch",
				providerRequestSent: false,
				scriptedSendsBefore: 0,
			});
			expect(probe.stats.requests).toBe(1);
		});

	it("recovers the original waiting-approval Pi task after private facet eviction without redriving effects", async () => {
		const name = crypto.randomUUID();
		let parent = await selected(name);
		await parent.admittedTurn("approval-bootstrap");
		await parent.beginNativeApproval("approval-original");
		let original;
		for (let n = 0; n < 100; n++) {
			original = (await parent.nativeApprovals())[0];
			if (original) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(original).toBeDefined();
		const before = JSON.parse(await parent.admittedInspect()).stats;
		expect(before.effects).toBe(0);
		await parent.scheduleNativeProbe(Date.now() + 1500);
		await abortAllDurableObjects();
		parent = await selected(name);
		await new Promise((resolve) => setTimeout(resolve, 1700));
		await runDurableObjectAlarm(parent);
		expect((await parent.nativeApprovals())[0]?.approvalId).toBe(
			original!.approvalId,
		);
		expect(JSON.parse(await parent.admittedInspect()).stats).toMatchObject({
			requests: before.requests,
			effects: 0,
		});
		await parent.approveNative(original!.approvalId);
		for (let n = 0; n < 100; n++) {
			if (JSON.parse(await parent.admittedInspect()).stats.effects === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(JSON.parse(await parent.admittedInspect()).stats.effects).toBe(1);
	});
	it("wakes a registered private Pi turn through the real root alarm after eviction", async () => {
		const name = crypto.randomUUID();
		let parent = await selected(name);
		await parent.admittedTurn("before-wake");
		const address = await parent.scheduleNativeTurn(
			"native-wake",
			Date.now() + 1500,
		);
		const alarm = await parent._cf_getFacetLifecycleAlarm(
			address.ownerPath,
			address.identityName,
		);
		expect(alarm).not.toBeNull();
		await runInDurableObject(parent, async (_actual, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM cf_agents_jobs WHERE capability='dynamic-agents'",
					)
					.toArray(),
			).toHaveLength(1);
		});
		await abortAllDurableObjects();
		parent = await selected(name);
		await new Promise((resolve) => setTimeout(resolve, 1700));
		await runDurableObjectAlarm(parent);
		expect(JSON.parse(await parent.admittedInspect()).stats.requests).toBe(2);
		const next = await parent._cf_getFacetLifecycleAlarm(
			address.ownerPath,
			address.identityName,
		);
		expect(next).toBeGreaterThan(alarm!);
		await runInDurableObject(parent, async (actual, state) => {
			await expect(
				actual._cf_syncFacetLifecycleAlarm(
					address.ownerPath,
					"wrong",
					Date.now() + 60000,
				),
			).rejects.toThrow(/identity/);
			await expect(
				actual._cf_syncFacetLifecycleAlarm(
					[
						...address.ownerPath.slice(0, 1),
						{ className: "ConversationFacet", name: "unregistered" },
					],
					address.identityName,
					Date.now() + 60000,
				),
			).rejects.toThrow(/registered/);
			await expect(
				actual._cf_syncFacetLifecycleAlarm(
					[
						...address.ownerPath.slice(0, 1),
						{ className: "PiStorageFixture", name: "admitted" },
					],
					address.identityName,
					Date.now() + 60000,
				),
			).rejects.toThrow(/registered/);
			await expect(
				actual._cf_syncFacetLifecycleAlarm(
					[
						{ ...address.ownerPath[0]!, name: "wrong-parent" },
						...address.ownerPath.slice(1),
					],
					address.identityName,
					Date.now() + 60000,
				),
			).rejects.toThrow(/path/);
			expect(
				state.storage.sql.exec("SELECT * FROM cf_agents_sub_agents").toArray(),
			).toHaveLength(1);
		});
		await parent._cf_syncFacetLifecycleAlarm(
			address.ownerPath,
			address.identityName,
			null,
		);
		expect(
			await parent._cf_getFacetLifecycleAlarm(
				address.ownerPath,
				address.identityName,
			),
		).toBeNull();
		await parent.scheduleNativeProbe(Date.now() + 500);
		await parent.quarantineParent();
		await abortAllDurableObjects();
		parent = await selected(name);
		await new Promise((resolve) => setTimeout(resolve, 700));
		await runDurableObjectAlarm(parent);
		await runInDurableObject(parent, async (actual) => {
			await expect(
				actual._cf_runFacetLifecycleAlarm(
					address.ownerPath,
					address.identityName,
				),
			).rejects.toThrow(/admission denied/);
		});
		expect(JSON.parse(await parent.admittedInspect()).stats.requests).toBe(2);
	});
	it("binds real registered child input through eviction and denies held parent dispatch", async () => {
		const name = crypto.randomUUID();
		let parent = await selected(name);
		const first = await parent.admittedTurn("selected-turn");
		expect(JSON.parse(await parent.admittedInspect()).stats.requests).toBe(1);
		await abortAllDurableObjects();
		parent = await selected(name);
		expect(await parent.admittedTurn("selected-turn")).toEqual(first);
		expect(JSON.parse(await parent.admittedInspect()).stats.requests).toBe(1);
		await parent.quarantineParent();
		await runInDurableObject(parent, async (actual) => {
			await expect(actual.admittedTurn("denied-turn")).rejects.toThrow();
		});
		expect(JSON.parse(await parent.admittedInspect()).stats.requests).toBe(1);
	});
	it("cold quarantined child boots the inert receiver before Pi startup", async () => {
		const name = crypto.randomUUID();
		let parent = await selected(name);
		await parent.admittedTurn("quarantine-child");
		await parent.quarantineChild();
		await abortAllDurableObjects();
		parent = await selected(name);
		await runInDurableObject(parent, async (actual) => {
			await expect(actual.admittedInspect()).rejects.toThrow();
		});
	});
});

describe("native daily-log settlement", () => {
	for (const failDrain of [false, true])
		it(`settles known ACK atomically or rolls back failed drain (${failDrain}); fences unresolved next ticks`, async () => {
			const { admittedTediDo } = await import("../tedi-do");
			const { RuntimeAdmissionDO } =
				await import("../../src/runtime-admission-do");
			const ns = (env as unknown as { PI_TEST: DurableObjectNamespace })
				.PI_TEST;
			await runInDurableObject(
				ns.get(ns.idFromName(crypto.randomUUID())),
				async (_agent, ctx) => {
					const owner = {
						tediId: "native-daily",
						orgId: "org",
						objectId: ctx.id.toString(),
					};
					const entry = {
						ts: 1000,
						role: "user",
						turnId: "turn",
						content: "native fixture",
					};
					ctx.storage.sql.exec(
						"CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
					);
					ctx.storage.sql.exec(
						"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
						JSON.stringify({ ...owner, pendingDailyEntries: [entry] }),
					);
					const admission = new RuntimeAdmissionDO(ctx.storage, owner);
					admission.gate.initialize({
						operationId: "baseline",
						state: "active",
						evidence: await admission.prepareEvidence("initialize"),
					});
					await admission.beginAcceptedTurn({
						runId: "original",
						sessionKey: "original",
						principalId: owner.tediId,
						input: { kind: "daily" },
						expectedGeneration: 1,
					});
					const parent = admittedTediDo(ctx, owner);
					parent.state = {
						...owner,
						slug: "native",
						pendingDailyEntries: [entry],
					};
					parent.ensureIdentity = async () => {};
					parent.dailyLogWriteLock = Promise.resolve();
					let transactional = false;
					const nativeTransaction = ctx.storage.transactionSync.bind(
						ctx.storage,
					);
					parent.ctx = {
						id: ctx.id,
						storage: {
							get: ctx.storage.get.bind(ctx.storage),
							put: ctx.storage.put.bind(ctx.storage),
							sql: ctx.storage.sql,
							kv: ctx.storage.kv,
							transactionSync: (run: () => unknown) =>
								nativeTransaction(() => {
									transactional = true;
									try {
										return run();
									} finally {
										transactional = false;
									}
								}),
						},
					};
					parent.setState = (next: unknown) => {
						expect(transactional).toBe(true);
						expect(
							ctx.storage.kv.get("runtime-admission-artifacts:original"),
						).toBeDefined();
						ctx.storage.sql.exec(
							"UPDATE cf_agents_state SET state=?",
							JSON.stringify(next),
						);
						if (failDrain) throw new Error("synthetic drain failure");
						parent.state = next;
					};
					parent.env = {
						CF_ACCOUNT_ID: "fixture",
						ARTIFACTS: {
							get: async () => ({
								createToken: async () => ({ plaintext: "synthetic-token" }),
							}),
						},
					};
					const savedFetch = globalThis.fetch;
					let uploads = 0;
					const packet = (text: string) =>
						`${(new TextEncoder().encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;
					globalThis.fetch = (async (
						url: unknown,
						init: RequestInit | undefined,
					) => {
						if (init?.method === "POST") {
							uploads++;
							admission.gate.quarantine({
								operationId: "hold-during-push",
								expectedGeneration: 1,
								reason: "fixture hold",
							});
							return new Response(
								packet(
									"\x01" +
										packet("unpack ok\n") +
										packet("ok refs/heads/main\n") +
										"0000",
								) + "0000",
								{
									headers: {
										"Content-Type": "application/x-git-receive-pack-result",
									},
								},
							);
						}
						const service = String(url).includes("git-receive-pack")
							? "git-receive-pack"
							: "git-upload-pack";
						return new Response(
							packet(`# service=${service}\n`) +
								"0000" +
								packet(
									"0000000000000000000000000000000000000000 capabilities^{}\0report-status delete-refs ofs-delta side-band-64k\n",
								) +
								"0000",
							{
								headers: {
									"Content-Type": `application/x-${service}-advertisement`,
								},
							},
						);
					}) as typeof fetch;
					try {
						if (failDrain) {
							await expect(parent.onDailyLogFlush("original")).rejects.toThrow(
								"synthetic drain failure",
							);
							expect(
								ctx.storage.kv.get("runtime-admission-artifacts:original"),
							).toBeUndefined();
							expect(
								ctx.storage.kv.get("runtime-admission-artifacts-pending"),
							).toMatchObject({ stage: "running" });
							expect(
								JSON.parse(
									ctx.storage.sql
										.exec<{ state: string }>(
											"SELECT state FROM cf_agents_state",
										)
										.toArray()[0]!.state,
								).pendingDailyEntries,
							).toEqual([entry]);
							parent.assertChatTurnActive = async () => {};
							await expect(
								parent.onDailyLogFlush("later-tick"),
							).rejects.toThrow(/push is unresolved/);
							expect(uploads).toBe(1);
							return;
						}
						const receipt = await parent.onDailyLogFlush("original");
						expect(receipt.acknowledgedRef).toBe("refs/heads/main");
						expect(uploads).toBe(1);
						expect(parent.state.pendingDailyEntries).toEqual([]);
						expect(
							ctx.storage.kv.get("runtime-admission-artifacts-pending"),
						).toBeUndefined();
						expect(admission.read()?.state).toBe("quarantined");
						expect(
							JSON.parse(
								ctx.storage.sql
									.exec<{ state: string }>("SELECT state FROM cf_agents_state")
									.toArray()[0]!.state,
							).pendingDailyEntries,
						).toEqual([]);
						parent.assertChatTurnActive = async () => {}; // Independently exercise the unresolved push fence.
						await ctx.storage.put("runtime-admission-artifacts-pending", {
							runId: "lost",
							snapshot: [entry],
							stage: "running",
						});
						parent.state.pendingDailyEntries = [entry];
						await expect(parent.onDailyLogFlush("next-tick")).rejects.toThrow(
							/push is unresolved/,
						);
						expect(uploads).toBe(1);
						expect(parent.state.pendingDailyEntries).toEqual([entry]);
					} finally {
						globalThis.fetch = savedFetch;
					}
				},
			);
		});
});
