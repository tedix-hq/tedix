import { SkillGuidanceTurnGate } from "./skill-guidance-store-do";
import { buildRetrievalCorpus } from "./skill-retrieval-corpus-store-do";
import assert from "node:assert/strict";
import { TurnExecutionRestrictionSchema } from "@tedix/api-contract/schemas/turn-execution-restriction";
import {
	resolveTurnExecutionRestriction,
	assertOriginalExecutionRestriction,
	recordRestrictedProviderCall,
} from "./turn-execution-restriction";
import {
	facetRunnerProbe,
	mcpFacetTurnProbe,
	MCP_FACET_TURN_INPUT,
	memoryStorage,
	tediDo,
	nativeToolMarkers,
} from "../test/tedi-do";
const restriction = { tools: "none", learning: "disabled" } as const;
for (const value of [
	null,
	{},
	{ tools: "all", learning: "disabled" },
	{ tools: "none", learning: "normal" },
	{ ...restriction, allow: true },
])
	assert.equal(TurnExecutionRestrictionSchema.safeParse(value).success, false);
assert.equal(
	resolveTurnExecutionRestriction(undefined, { sessionKey: "main" }),
	undefined,
);
assert.deepEqual(
	resolveTurnExecutionRestriction(restriction, {
		sessionKey: "workflow:reddit-judge-fixture",
	}),
	restriction,
);
assert.throws(() =>
	resolveTurnExecutionRestriction(restriction, {
		sessionKey: "workflow:synth:fixture",
	}),
);
assert.throws(() =>
	resolveTurnExecutionRestriction(restriction, {
		sessionKey: "main",
		evaluation: {},
	}),
);
const storage = memoryStorage();
await storage.put("runtime-admission-workflow:run", {
	params: { executionRestriction: restriction },
});
await assertOriginalExecutionRestriction(
	storage as unknown as DurableObjectStorage,
	"run",
	restriction,
);
await assert.rejects(
	() =>
		assertOriginalExecutionRestriction(
			storage as unknown as DurableObjectStorage,
			"run",
			undefined,
		),
	/changed/,
);
const call = { tools: [], toolChoice: { type: "none" as const } },
	applied = {
		storage: storage as unknown as DurableObjectStorage,
		runId: "run",
		providerAttemptId: "attempt",
		restriction,
		facetToolCount: 0,
		call,
	};
await recordRestrictedProviderCall(applied);
await recordRestrictedProviderCall(applied);
assert.equal(
	(await storage.list({ prefix: "turn-execution-restriction:" })).size,
	1,
);
for (const change of [
	{ facetToolCount: 1 },
	{ call: { tools: [], toolChoice: { type: "auto" as const } } },
	{ call: { tools: undefined, toolChoice: { type: "none" as const } } },
])
	await assert.rejects(() =>
		recordRestrictedProviderCall({ ...applied, ...change }),
	);
const prepare = mcpFacetTurnProbe();
assert.deepEqual(
	(
		await prepare.prepareMcpFacetTurn({
			...MCP_FACET_TURN_INPUT,
			executionRestriction: restriction,
			toolsOnly: true,
		})
	).tools,
	{},
);
const input = {
	sessionKey: "main",
	guardedUserText: "question",
	userTs: 1,
	system: "ORIGINAL PERSONA",
	runId: "run-1",
	maxSteps: 8,
	tools: {
		write: {
			execute: async () => {
				throw Error("must not run");
			},
		},
	},
	surface: "mcp",
};
const normal = facetRunnerProbe(),
	limited = facetRunnerProbe();
await normal.agent.runConversationFacetTurn(input);
await limited.agent.runConversationFacetTurn({
	...input,
	executionRestriction: restriction,
});
assert.deepEqual(Object.keys(limited.registryDuringTurn() as object), []);
assert.deepEqual(limited.configs[0]?.toolDescriptors, []);
assert.deepEqual(limited.configs[0]?.executionRestriction, restriction);
for (const key of [
	"system",
	"generation",
	"modelRef",
	"adaptiveRouting",
	"maxSteps",
])
	assert.deepEqual(limited.configs[0]?.[key], normal.configs[0]?.[key], key);
async function commit(restricted: boolean) {
	const calls: string[] = [];
	const a = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		async ensureIdentity() {},
		sessionHarness: {
			appendTurn: async () => {
				calls.push("transcript");
				return true;
			},
		},
		broadcast() {},
		toolCallRefsForRun: () => [],
		toolExecutionEvidenceForRun: () => [],
		async onLedgerMirror() {
			calls.push("ledger");
		},
		async dispatchTurnMemoryEffects() {
			calls.push("memory");
		},
		async enqueueCompaction() {
			calls.push("compaction");
		},
	});
	await a.commitAssistantTurnImpl({
		sessionKey: "main",
		runId: "run",
		conversationId: "c",
		userTs: 1,
		userText: "q",
		assistantText: "a",
		stopReason: "stop",
		toolCalls: [],
		...(restricted ? { executionRestriction: restriction } : {}),
	});
	return calls;
}
assert.deepEqual(await commit(true), ["transcript", "ledger"]);
assert.deepEqual(await commit(false), [
	"transcript",
	"memory",
	"ledger",
	"compaction",
]);
for (const asyncMode of [false, true]) {
	const dispatched: Record<string, unknown>[] = [],
		durable: Record<string, unknown>[] = [],
		a = tediDo({
			env: {},
			name: "isolate-fixture",
			state: { tediId: "tedi-1", orgId: "org-1", slug: "fixture" },
			ctx: { storage: memoryStorage() },
			sessionRepo: { findTurnByIdempotencyKey: () => null },
			async ensureIdentity() {},
			async schedule() {
				return { id: "watchdog" };
			},
			async runWorkflow(_n: string, p: Record<string, unknown>) {
				dispatched.push(p);
			},
			async getPlatformClient() {
				return { recordRuntimeEvent: async () => {} };
			},
			async runDurableChatTurn(p: Record<string, unknown>) {
				durable.push(p);
				return {
					ok: true,
					run_id: "run",
					session_key: "main",
					assistant: null,
				};
			},
			computerWorkspace: () => ({ workspace: {} }),
			...nativeToolMarkers(),
		});
	const request = new Request("https://internal/__internal/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Service-Binding": "true",
			"x-tedix-caller-trust": "member",
		},
		body: JSON.stringify({
			text: "q",
			client_request_id: "request",
			async: asyncMode,
			executionRestriction: restriction,
		}),
	});
	const r = await a.onRequest(request.clone());
	assert.equal(r.status, asyncMode ? 202 : 200);
	assert.deepEqual(
		(asyncMode ? dispatched : durable)[0]?.executionRestriction,
		restriction,
	);
	if (asyncMode) {
		assert.equal(dispatched[0]?.learningMode, "disabled");
		await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal((await a.onRequest(request.clone())).status, 202);
		assert.equal(
			dispatched.length,
			1,
			"same immutable injection dispatch is not repeated",
		);
	}
}
console.log(
	"PASS: strict restriction, real facet registry/model parity, injection and no-learning commit",
);

// Reading guidance must not train its recency or later influence state.
async function directiveRead(disabled: boolean) {
	let touches = 0;
	const priorInjected = [{ sentinel: "normal turn influence pending" }];
	const agent = tediDo({
		lastInjectedDirectives: priorInjected,
		compiledDirectives: [
			{
				strength: "always",
				directive: "Verify workflow evidence before reporting results",
				category: "quality",
				evidenceCount: 10,
				successRate: 1,
				compiledAt: "2026-01-01T00:00:00.000Z",
				rationaleIds: ["r"],
				provenanceHash: "hash",
				lastMatchedAt: null,
			},
		],
		async ensureDirectivesLoaded() {},
		getDirectiveStore: () => ({
			updateLastMatched: async () => {
				touches++;
			},
		}),
		async recordDirectiveUsage() {},
	});
	const text = await agent.directivesPromptAddendum(
		"Verify workflow evidence before reporting results",
		null,
		disabled,
	);
	return {
		text,
		touches,
		lastMatched: agent.compiledDirectives[0].lastMatchedAt,
		injected: agent.lastInjectedDirectives,
		priorInjected,
	};
}
const directiveLimited = await directiveRead(true),
	directiveNormal = await directiveRead(false);
assert.ok(directiveLimited.text.includes("Verify workflow evidence"));
assert.equal(directiveLimited.text, directiveNormal.text);
assert.equal(directiveLimited.touches, 0);
assert.equal(directiveLimited.lastMatched, null);
assert.equal(directiveLimited.injected, directiveLimited.priorInjected);
assert.notEqual(directiveNormal.injected, directiveNormal.priorInjected);
assert.equal(directiveNormal.touches, 1);
assert.ok(directiveNormal.lastMatched);

// Settled redelivery cannot remove a restriction before returning the old reply.
for (const asyncMode of [false, true]) {
	const store = memoryStorage();
	await store.put("runtime-admission-workflow:tedi-1:mcp:request", {
		params: { executionRestriction: restriction },
	});
	const a = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage: store },
		async ensureIdentity() {},
		sessionRepo: {
			findTurnByIdempotencyKey: () => {
				assert.fail(
					"Changed restriction must be rejected before settled fast-path",
				);
			},
		},
	});
	if (asyncMode) {
		const result = await a.onRequest(
			new Request("https://internal/__internal/inject", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
					"x-tedix-caller-trust": "member",
				},
				body: JSON.stringify({
					text: "q",
					client_request_id: "request",
					async: true,
				}),
			}),
		);
		assert.equal(result.status, 500);
		assert.match(await result.text(), /restriction changed/);
	} else
		await assert.rejects(
			() =>
				a.runDurableChatTurn({
					sessionKey: "main",
					text: "q",
					clientRequestId: "request",
				}),
			/restriction changed/,
		);
}

await assert.rejects(
	() =>
		assertOriginalExecutionRestriction(
			memoryStorage() as unknown as DurableObjectStorage,
			"historical",
			restriction,
			true,
		),
	/unavailable/,
);

// Cold and warm guidance retain the same text without cache writes or shared corpus changes.
for (const cached of [null, "Available cached guidance"]) {
	async function context(disabled: boolean) {
		const writes: string[] = [];
		const background: Promise<unknown>[] = [];
		const ranks: unknown[] = [];
		const agent = tediDo({
			ctx: { waitUntil: (task: Promise<unknown>) => background.push(task) },
			env: {
				TEDI_SKILL_RETRIEVAL_TOP_K: "1",
				TEDI_SKILL_RETRIEVAL_MIN_OVERLAP: "1",
			},
			state: { tediId: "tedi-1" },
			skillGuidanceText: cached,
			retrievalCorpus: null,
			ensureSkillGuidanceLoaded() {},
			ensureRetrievalCorpusLoaded() {},
			async resolveTurnTelemetry() {
				return {
					runId: "same-run",
					platform: {
						rankSkills: async (input: { skillIds: string[] }) => {
							ranks.push(input);
							return {
								skillIds: [...input.skillIds].reverse(),
								executionAttempts: [],
								usagePersistence: "persisted",
							};
						},
					},
				};
			},
			async recordSkillRetrieval() {},
			async directivesPromptAddendum() {
				return "";
			},
			async brainDigestAddendum() {
				return "same memory";
			},
			async getPlatformClient() {
				return {
					listSkillsForTedi: async () => ({
						entries: [
							{
								id: "skill-1",
								title: "Verify workflow evidence first",
								slug: "verify",
								tediId: "tedi-1",
								summary: "Verify evidence",
								lifecycleState: "active",
							},
							{
								id: "skill-2",
								title: "Verify workflow evidence second",
								slug: "verify-second",
								summary: "Verify workflow evidence",
								lifecycleState: "active",
								tediId: "tedi-1",
							},
						],
					}),
				};
			},
			cacheRetrievalCorpus(
				entries: Parameters<typeof buildRetrievalCorpus>[0],
			) {
				agent.retrievalCorpus = buildRetrievalCorpus(entries);
				writes.push("corpus");
			},
			getSkillGuidanceStore: () => ({
				load: () => (cached ? { text: cached } : null),
				save() {
					writes.push("save");
				},
				touch() {
					writes.push("touch");
				},
			}),
		});
		const text = await agent.cognitiveAddenda(
			"main",
			"Verify workflow evidence before reporting",
			null,
			disabled,
		);
		await Promise.all(background);
		return { text, writes, ranks, corpus: agent.retrievalCorpus };
	}
	const restricted = await context(true),
		normal = await context(false);
	assert.equal(restricted.text, normal.text);
	assert.deepEqual(restricted.writes, []);
	assert.equal(restricted.corpus, null);
	assert.ok(normal.writes.length > 0);
	assert.deepEqual(restricted.ranks, normal.ranks);
	assert.equal(restricted.ranks.length, 1);
	assert.ok(restricted.text.includes("verify-second"));
}
// Semantic recall still runs with identical query/results; only bookkeeping is disabled.
async function recall(disabled: boolean) {
	const calls: unknown[][] = [];
	const agent = tediDo({
		brainDigest: null,
		async ensureBrainDigestLoaded() {},
		messagesForSession: () => [],
		async getPlatformClient() {
			return {
				memorySearch: async (...args: unknown[]) => {
					calls.push(args);
					return {
						results: [
							{ fact: { content: "Scoped remembered fact", metadata: {} } },
						],
					};
				},
				getTurnMemory: async () => ({
					checkedAt: "2026-01-01",
					preferences: [],
					tasks: [],
					unresolvedReferences: [],
					truncated: false,
				}),
			};
		},
	});
	return {
		text: await agent.brainDigestAddendum(
			"Find scoped remembered workflow evidence",
			undefined,
			"main",
			disabled,
		),
		calls,
	};
}
const recallLimited = await recall(true),
	recallNormal = await recall(false);
assert.equal(recallLimited.text, recallNormal.text);
assert.ok(recallLimited.text.includes("Scoped remembered fact"));
assert.deepEqual(
	recallLimited.calls[0]?.slice(0, 2),
	recallNormal.calls[0]?.slice(0, 2),
);
assert.deepEqual(recallLimited.calls[0]?.[2], { recordAccess: false });
assert.equal(recallNormal.calls[0]?.[2], undefined);

// Read-only guidance observes the same negative cache without refreshing it.
{
	let normalBuilds = 0,
		readonlyBuilds = 0;
	const gate = new SkillGuidanceTurnGate({
		build: async () => {
			normalBuilds++;
			return "";
		},
		background: () => assert.fail("unexpected background refresh"),
		now: () => 100,
	});
	assert.equal(await gate.textForTurn(""), "");
	assert.equal(
		await gate.readOnlyTextForTurn("", async () => {
			readonlyBuilds++;
			return "new guidance";
		}),
		"",
	);
	assert.equal(
		await gate.readOnlyTextForTurn("cached", async () => {
			readonlyBuilds++;
			return "new guidance";
		}),
		"cached",
	);
	assert.equal(normalBuilds, 1);
	assert.equal(readonlyBuilds, 0);
}

// Integrated cache states must preserve the ordinary guidance/retrieval selection.
for (const state of [
	"negative-warm-attempt",
	"cold-stale-corpus",
	"cold-guidance-unavailable",
] as const) {
	async function readContext(disabled: boolean) {
		const catalog = [
			{
				id: "new",
				title: "Verify workflow evidence new",
				summary: "Verify workflow evidence",
				slug: "new-evidence",
				tediId: "tedi-1",
				lifecycleState: "active",
			},
		];
		const priorCorpus =
			state === "cold-stale-corpus"
				? buildRetrievalCorpus([
						{ ...catalog[0]!, id: "old", slug: "old-evidence" },
					])
				: null;
		let reads = 0,
			writes = 0;
		const gate = new SkillGuidanceTurnGate({
			build: async () => "",
			background: () => assert.fail("unexpected background build"),
			now: () => 100,
		});
		if (state === "negative-warm-attempt") await gate.textForTurn("");
		const agent = tediDo({
			env: {
				TEDI_SKILL_RETRIEVAL_TOP_K: "1",
				TEDI_SKILL_RETRIEVAL_MIN_OVERLAP: "1",
			},
			state: { tediId: "tedi-1" },
			skillGuidanceText: null,
			skillGuidanceGate: state === "negative-warm-attempt" ? gate : null,
			retrievalCorpus: priorCorpus,
			retrievalCorpusWarmAttempted: state !== "cold-guidance-unavailable",
			ensureSkillGuidanceLoaded() {},
			ensureRetrievalCorpusLoaded() {},
			async resolveTurnTelemetry() {
				return null;
			},
			async recordSkillRetrieval() {},
			async directivesPromptAddendum() {
				return "";
			},
			async brainDigestAddendum() {
				return "";
			},
			async getPlatformClient() {
				return {
					listSkillsForTedi: async () => {
						reads++;
						if (state === "cold-guidance-unavailable" && reads === 1)
							throw Error("temporary unavailable catalog");
						return { entries: catalog };
					},
				};
			},
			cacheRetrievalCorpus(
				entries: Parameters<typeof buildRetrievalCorpus>[0],
			) {
				writes++;
				agent.retrievalCorpus = buildRetrievalCorpus(entries);
			},
			getSkillGuidanceStore: () => ({
				load: () => null,
				save() {
					writes++;
				},
				touch() {
					writes++;
				},
			}),
		});
		const text = await agent.cognitiveAddenda(
			"main",
			"Verify workflow evidence",
			null,
			disabled,
		);
		return { text, reads, writes, corpus: agent.retrievalCorpus, priorCorpus };
	}
	const restricted = await readContext(true),
		normal = await readContext(false);
	assert.equal(restricted.text, normal.text, state);
	assert.equal(restricted.reads, normal.reads, state);
	assert.equal(restricted.writes, 0);
	assert.equal(restricted.corpus, restricted.priorCorpus);
	if (state === "negative-warm-attempt") {
		assert.equal(restricted.reads, 0);
		assert.equal(restricted.text, "");
	} else {
		assert.ok(restricted.text.includes("new-evidence"));
		assert.ok(!restricted.text.includes("old-evidence"));
	}
}

// Disabled retrieval must not pay for a cold corpus when guidance has a negative cache.
{
	const gate = new SkillGuidanceTurnGate({
		build: async () => "",
		background: () => assert.fail("unexpected refresh"),
		now: () => 100,
	});
	await gate.textForTurn("");
	const agent = tediDo({
		env: { TEDI_SKILL_RETRIEVAL_TOP_K: "0" },
		skillGuidanceText: null,
		skillGuidanceGate: gate,
		retrievalCorpus: null,
		retrievalCorpusWarmAttempted: false,
		ensureSkillGuidanceLoaded() {},
		ensureRetrievalCorpusLoaded() {
			assert.fail("disabled retrieval must not load corpus");
		},
		async getPlatformClient() {
			assert.fail("disabled retrieval must not read catalog");
		},
		async directivesPromptAddendum() {
			return "";
		},
		async brainDigestAddendum() {
			return "";
		},
	});
	assert.equal(
		await agent.cognitiveAddenda("main", "Verify evidence", null, true),
		"",
	);
}
