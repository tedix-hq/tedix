/**
 * Parent-side contract for facet-per-conversation turns (the facet itself is
 * covered by conversation-facet.test.ts). Every MCP, workflow and SSE turn runs
 * on its conversation's facet; the parent owns the runId dedup contract, the
 * canonical harness appends, the per-runId tool registry, budget settlement,
 * and the ledger mirror.
 */
import assert from "node:assert/strict";
import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import {
	chatTurnProbe,
	facetRunnerProbe,
	facetWorkflowTurnProbe,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	memoryStorage,
	tediDo,
} from "../test/tedi-do";
import * as runtimeWorker from "./index";
import { wrapUntrustedInput } from "./untrusted-input";

const IMAGE = { type: "image", mediaType: "image/png", data: "aGk=" };

// ── the facet runner: registry lifecycle, fresh vs hydrated history ──────────
const facetInput = {
	sessionKey: "main",
	guardedUserText: "hello",
	userTs: 1,
	system: "SYSTEM",
	runId: "run-1",
	maxSteps: 8,
	tools: { probe: { execute: async () => "ok" } },
	surface: "mcp",
};

{
	const probe = facetRunnerProbe({ usage: { totalTokens: 42 } });
	const result = await probe.agent.runConversationFacetTurn({
		...facetInput,
		workItemId: "work-1",
	});
	assert.equal(result.assistantText, "answer");
	assert.deepEqual(result.usage, { totalTokens: 42 });
	assert.equal(probe.registryDuringTurn(), facetInput.tools);
	assert.equal(probe.agent.activeFacetTurnTools.size, 0);
	assert.equal(probe.agent.activeFacetTurnConversations.size, 0);
	assert.deepEqual(probe.calls, ["configure", "run:hello"]);
	assert.deepEqual(probe.settled, [["run-1", 42]], "cumulative settlement");
	assert.ok(probe.configs[0]);
	assert.deepEqual(
		(probe.configs[0].aigMetadata as { correlation: unknown }).correlation,
		{ runId: "run-1", sessionKey: "main", workItemId: "work-1" },
		"gateway attribution carries the concrete Work Item",
	);
}
{
	// Ordinary server-classified chat, delegated-agent, and background lanes may
	// use the adaptive default; tool authority remains independently enforced.
	const eligible = facetRunnerProbe();
	await eligible.agent.runConversationFacetTurn({
		...facetInput,
		modelSurface: "cron",
		admissionClass: "background",
		delegated: false,
	});
	assert.deepEqual(eligible.configs[0]?.adaptiveRouting, {
		surface: "cron",
		authority: "ordinary",
		reproducibility: "adaptive",
		sovereignty: "unconstrained",
	});
	const chat = facetRunnerProbe();
	await chat.agent.runConversationFacetTurn({
		...facetInput,
		modelSurface: "chat",
		admissionClass: "operator",
		delegated: true,
	});
	assert.deepEqual(chat.configs[0]?.adaptiveRouting, {
		surface: "chat",
		authority: "ordinary",
		reproducibility: "adaptive",
		sovereignty: "unconstrained",
	});

	for (const override of [
		{
			modelSurface: "cron",
			admissionClass: "governed_learning",
			delegated: false,
		},
		{
			modelSurface: "cron",
			admissionClass: "background",
			delegated: false,
			authorityEnvelope: {} as never,
		},
		{
			modelSurface: "chat",
			admissionClass: "operator",
			images: [{ type: "file", mediaType: "image/png", data: "x" }] as never,
		},
	] as const) {
		const denied = facetRunnerProbe();
		await denied.agent.runConversationFacetTurn({ ...facetInput, ...override });
		assert.deepEqual(denied.configs[0]?.adaptiveRouting, {
			surface: override.modelSurface,
			authority:
				"authorityEnvelope" in override ? "authority-sensitive" : "ordinary",
			reproducibility: "adaptive",
			sovereignty: "unconstrained",
		});
	}
}
{
	// A facet failure is a turn error, and the registry is still cleaned up.
	const probe = facetRunnerProbe({ fail: true });
	const result = await probe.agent.runConversationFacetTurn(facetInput);
	assert.deepEqual(result, { assistantText: "", turnError: "facet evicted" });
	assert.equal(probe.agent.activeFacetTurnTools.size, 0);
}
{
	// The first facet turn hydrates capped parent history; later turns do not.
	const first = facetRunnerProbe({ priorTurnCount: 0 });
	await first.agent.runConversationFacetTurn(facetInput);
	assert.match(first.calls[1]!, /earlier question[\s\S]*hello$/);
	const later = facetRunnerProbe({ priorTurnCount: 3 });
	await later.agent.runConversationFacetTurn(facetInput);
	assert.equal(later.calls[1], "run:hello");
}
{
	// A fresh-history turn bypasses configuration + hydration entirely.
	const probe = facetRunnerProbe({ priorTurnCount: 0 });
	await probe.agent.runConversationFacetTurn({
		...facetInput,
		freshHistory: true,
	});
	assert.deepEqual(probe.calls, ["fresh:hello"]);
}

// ── the SSE facet pump ───────────────────────────────────────────────────────
{
	const deltas: string[] = [];
	const probe = facetRunnerProbe({
		stream: [
			JSON.stringify({ kind: "delta", text: "ans" }),
			JSON.stringify({
				kind: "done",
				requestId: "r",
				text: "answer",
				turnCount: 1,
				turnMs: 1,
				usage: { totalTokens: 7 },
			}),
		],
	});
	const result = await probe.agent.streamConversationFacetTurn({
		sessionKey: "main",
		userText: "hello",
		userTs: 1,
		system: "SYSTEM",
		runId: "run-1",
		maxSteps: 8,
		tools: facetInput.tools,
		onDelta: (text: string) => deltas.push(text),
	});
	assert.equal(result.assistantText, "answer");
	assert.deepEqual(deltas, ["ans"]);
	assert.deepEqual(probe.settled, [["run-1", 7]]);
	assert.equal(probe.registryDuringTurn(), facetInput.tools);
	assert.equal(probe.agent.activeFacetTurnTools.size, 0);
}
{
	const probe = facetRunnerProbe({
		stream: [JSON.stringify({ kind: "delta", text: "partial" })],
	});
	const result = await probe.agent.streamConversationFacetTurn({
		sessionKey: "main",
		userText: "hello",
		userTs: 1,
		system: "SYSTEM",
		runId: "run-1",
		maxSteps: 8,
		tools: {},
		onDelta() {},
	});
	assert.equal(result.turnError, "facet stream ended without a terminal frame");
	assert.equal(probe.agent.activeFacetTurnTools.size, 0);
}

// ── MCP turns execute through the durable workflow facet ─────────────────────
{
	const probe = facetWorkflowTurnProbe({
		async facetTurn() {
			return {
				assistantText: "answer",
				turnError: null,
				usage: { totalTokens: 9 },
			};
		},
	});
	const result = await probe.run({ userText: "look at this" });
	const runId = "tedi-1:mcp:req-1";
	assert.equal(result.text, "answer");
	assert.deepEqual(probe.order, [
		`append:user:${deriveIdempotencyKey(runId, "user")}`,
		"facet",
		"commit",
	]);
	assert.equal(
		probe.facetInputs[0]?.guardedUserText,
		wrapUntrustedInput("look at this", "mcp"),
	);
	assert.equal(probe.facetInputs[0]?.surface, "mcp");
	assert.equal(probe.facetInputs[0]?.runId, runId);
	assert.equal(probe.facetInputs[0]?.durableSubmissionId, `${runId}:segment:0`);
	assert.equal(probe.facetInputs[0]?.freshHistory, false);
	assert.equal(
		"images" in probe.facetInputs[0]!,
		false,
		"text-only workflow turns omit image parts",
	);
	assert.equal(probe.prepared.length, 1);
	assert.deepEqual(probe.commits[0]?.facetUsage, { totalTokens: 9 });
}

// ── the durable workflow turn ────────────────────────────────────────────────
{
	// Settled fast-path: a re-driven step returns the committed row, no turn.
	let facetRuns = 0;
	const agent = tediDo({
		facetWorkflowTurns: { run: (_id: string, run: () => unknown) => run() },
		keepAliveWhile: (run: () => unknown) => run(),
		async ensureIdentity() {},
		sessionRepo: {
			findTurnByIdempotencyKey: (_sessionKey: string, key: string) =>
				key === deriveIdempotencyKey("run-1", "assistant")
					? { content: "already answered" }
					: null,
		},
		async runFacetWorkflowTurnImpl() {
			facetRuns += 1;
		},
	});
	const result = await agent.runFacetWorkflowTurn({
		sessionKey: "main",
		runId: "run-1",
	});
	assert.deepEqual(result, {
		text: "already answered",
		stopReason: "settled",
		toolCalls: [],
	});
	assert.equal(facetRuns, 0);
}
{
	// A facet error throws so the
	// workflow re-drives or seals failure; tool outcomes and facet usage reach
	// the canonical commit, and the RPC result equals the committed text.
	let prepared = 0;
	const failing = facetWorkflowTurnProbe({
		async facetTurn() {
			return { assistantText: "", turnError: "provider down" };
		},
		fields: {
			async prepareMcpFacetTurn() {
				prepared += 1;
				return { system: "SYSTEM", tools: {}, turnBinding: null };
			},
		},
	});
	await assert.rejects(failing.run({}), /provider down/);
	assert.equal(prepared, 1);
	assert.deepEqual(failing.commits, []);

	const ok = facetWorkflowTurnProbe({
		async facetTurn() {
			return {
				assistantText: "done",
				turnError: null,
				usage: { totalTokens: 11 },
				stopReason: "step_ceiling",
			};
		},
		fields: {
			peekPendingToolSteps: () => [
				{
					stepNumber: 0,
					finishReason: "facet-tool-proxy",
					toolNames: ["exec"],
					toolResultCount: 1,
				},
			],
		},
	});
	const result = await ok.run({});
	assert.equal(result.text, ok.commits[0]?.assistantText);
	assert.deepEqual(ok.commits[0]?.facetUsage, { totalTokens: 11 });
	assert.equal(ok.commits[0]?.stopReason, "step_ceiling");
	assert.deepEqual(ok.commits[0]?.toolCalls, [{ name: "exec", ok: true }]);
}
{
	// A supervised segment settles through the continuation and returns the
	// exact committed segment.
	const commits: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		async commitAssistantTurn(commit: Record<string, unknown>) {
			commits.push(commit);
		},
	});
	const result = await agent.commitFacetWorkflowSegment(
		{
			runId: "run-1",
			workItemId: "work-1",
			homeRunId: "home-1",
			sessionKey: "main",
			conversationId: "conversation",
			userText: "work",
			userTs: 1,
		},
		{
			text: "segment text",
			stopReason: "stop",
			toolCalls: [{ name: "exec", ok: true }],
		},
	);
	assert.equal(commits[0]?.assistantText, "segment text");
	assert.deepEqual(commits[0]?.toolCalls, [{ name: "exec", ok: true }]);
	assert.equal(result.text, "segment text");
	assert.deepEqual(result.toolCalls, [{ name: "exec", ok: true }]);
}

// ── settlement: evidence captured before the ledger consumes the buffer ─────
{
	const order: string[] = [];
	const memory: Array<Record<string, unknown>> = [];
	const mirrors: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		async ensureIdentity() {},
		sessionHarness: { appendTurn: async () => true },
		broadcast() {},
		toolCallRefsForRun: () => {
			order.push("refs");
			return ["ref"];
		},
		toolExecutionEvidenceForRun: () => {
			order.push("evidence");
			return [{ tool: "exec" }];
		},
		async onLedgerMirror(payload: Record<string, unknown>) {
			order.push("ledger");
			mirrors.push(payload);
		},
		async dispatchTurnMemoryEffects(payload: Record<string, unknown>) {
			memory.push(payload);
		},
		enqueueCompaction() {},
	});
	await agent.commitAssistantTurnImpl({
		sessionKey: "main",
		runId: "run-1",
		conversationId: "conversation",
		userTs: 1,
		userText: "hello",
		assistantText: "done",
		stopReason: "stop",
		toolCalls: [],
		workItemId: "work-1",
		facetUsage: { totalTokens: 5 },
	});
	assert.deepEqual(order, ["refs", "evidence", "ledger"]);
	assert.deepEqual(mirrors[0]?.facetUsage, { totalTokens: 5 });
	assert.equal(memory[0]?.workItemId, "work-1");
	assert.deepEqual(memory[0]?.executionEvidence, [{ tool: "exec" }]);
}

// ── the tool proxy: buffered before execution, fail soft, digested ──────────
{
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		setState(next: unknown) {
			agent.state = next;
		},
		activeFacetTurnTools: new Map([
			[
				"run-1",
				{
					probe: {
						async execute() {
							// Buffered at the start boundary, before execution.
							const [entry] = agent.state.pendingToolSteps ?? [];
							assert.equal(entry?.steps?.[0]?.finishReason, "facet-tool-proxy");
							assert.equal(entry?.steps?.[0]?.toolResultCount, 0);
							return { ok: true, value: 1 };
						},
					},
				},
			],
		]),
		activeFacetTurnAuthorities: new Map(),
		activeFacetTurnConversations: new Map(),
		facetDispatchJournal: {
			claim: async () => true,
			markReturned: async () => {},
		},
		nativeToolLedger: {
			observe: (_context: unknown, _call: unknown, run: () => unknown) => run(),
		},
		async recordStepEvent() {
			throw new Error(
				"the facet mirrors the real model round; no synthetic step",
			);
		},
	});
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "run-1",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: { kind: "original-tool-turn", text: "probe" },
		expectedGeneration: 1,
	});
	await agent.executeFacetTool({
		runId: "run-1",
		toolCallId: "call-1",
		tool: "probe",
		args: {},
	});
	const step = agent.state.pendingToolSteps[0].steps[0];
	assert.deepEqual(step.toolNames, ["probe"]);
	assert.equal(step.toolCallCount, 1);
	assert.equal(step.toolResultCount, 1);
	assert.equal(typeof step.resultDigest, "string", "content-free digest");

	// A known original turn without a live registry returns a structured error.
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "run-gone",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: { kind: "original-tool-turn", text: "gone" },
		expectedGeneration: 1,
	});
	const missing = await agent.executeFacetTool({
		runId: "run-gone",
		toolCallId: "call-2",
		tool: "probe",
		args: {},
	});
	assert.equal((missing as { code?: string }).code, "facet_tool_unavailable");
}

// ── the shared MCP facet setup ───────────────────────────────────────────────
{
	await assert.rejects(
		mcpFacetTurnProbe().prepareMcpFacetTurn({
			...MCP_FACET_TURN_INPUT,
			workItemId: "work-1",
		}),
		/Incomplete Home-supervised MCP authority context/,
	);
	// Work attribution is captured for the native tools even when no MCP
	// runtime is available, and delegated turns get only the Computer tools
	// their execution surface allows.
	const contexts: unknown[] = [];
	const probe = mcpFacetTurnProbe({
		fields: {
			state: {
				tediId: "tedi-1",
				orgId: "org-1",
				slug: "acme",
				systemPrompt: "SYSTEM",
			},
			workspaceAiTools(_scope: unknown, context: unknown) {
				contexts.push(context);
				return {};
			},
			workstationAiTool: () => ({
				exec: {},
				open_computer: {},
				browser_open: {},
			}),
		},
	});
	const setup = await probe.prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		workItemId: "work-1",
		homeRunId: "home-1",
		executionSurface: "managed_job",
	});
	assert.equal((contexts[0] as { workItemId?: string }).workItemId, "work-1");
	assert.equal((contexts[0] as { homeRunId?: string }).homeRunId, "home-1");
	assert.equal("browser_open" in setup.tools, false);
}

// ── async inject threads the server-derived work boundary ────────────────────
{
	const dispatched: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage: memoryStorage() },
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async ensureIdentity() {},
		async schedule() {
			return { id: "watchdog" };
		},
		async runWorkflow(_name: string, params: Record<string, unknown>) {
			dispatched.push(params);
		},
		async getPlatformClient() {
			return { recordRuntimeEvent: async () => {} };
		},
	});
	const response = await agent.onRequest(
		new Request("https://do.internal/__internal/inject", {
			method: "POST",
			headers: { [CALLER_TRUST_HEADER]: "member" },
			body: JSON.stringify({
				text: "do the work",
				client_request_id: "req-1",
				async: true,
				metadata: {
					source: "kernelRuntime.delegate",
					executionSurface: "managed_job",
					workItemId: "work-1",
					homeRunId: "home-1",
				},
			}),
		}),
	);
	assert.equal(response.status, 202, await response.clone().text());
	assert.equal(dispatched[0]?.executionSurface, "managed_job");
	assert.equal(dispatched[0]?.workItemId, "work-1");
	assert.equal(typeof dispatched[0]?.authorityMode, "string");
	assert.ok("repositoryMode" in dispatched[0]!);
}

// ── Tedix OS SSE turns ride the facet pump with images threaded ──────────────
{
	const probe = chatTurnProbe({
		async facetTurn() {
			return { assistantText: "ok", usage: { totalTokens: 3 } };
		},
		fields: {
			async resolveAttachmentTurn(text: string) {
				return { content: text, images: [IMAGE] };
			},
		},
	});
	await probe.run({ text: "look" });
	assert.deepEqual(probe.facetInputs[0]?.images, [IMAGE]);
	const mirror = probe.queued.find(
		(entry) => entry.callback === "onLedgerMirror",
	);
	assert.ok(mirror);
	assert.deepEqual((mirror.payload as { facetUsage?: unknown }).facetUsage, {
		totalTokens: 3,
	});
}

// ── ledger mirror: prefer facet usage, else the parent step buffer ───────────
async function mirror(options: {
	unsettled?: boolean;
	facetUsage?: { totalTokens: number };
	stepTokens: number | null;
}) {
	const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
	const originalInput = { kind: "original-mcp-turn", text: "q" };
	const storage = memoryStorage();
	const agent = tediDo({
		ctx: {
			storage: {
				...storage,
				sql: {
					exec(query: string, runId: string) {
						assert.equal(
							query,
							"SELECT input FROM runtime_admission_identities WHERE run_id=?",
						);
						assert.equal(runId, "tedi-1:mcp:req-1");
						return {
							toArray: () => [{ input: JSON.stringify(originalInput) }],
						};
					},
				},
			},
		},
		state: {
			tediId: "tedi-1",
			orgId: "org-1",
			slug: "acme",
			ledgerConversationsSeen: [],
		},
		async ensureIdentity() {},
		setState(next: unknown) {
			agent.state = next;
		},
		async getPlatformClient() {
			return {
				async recordRuntimeEvent(event: { kind: string }) {
					events.push(event);
				},
			};
		},
		peekTotalTokens: () => options.stepTokens,
		peekPendingToolSteps: () =>
			options.stepTokens == null
				? []
				: [
						{
							stepNumber: 0,
							finishReason: "stop",
							toolNames: [],
							totalTokens: options.stepTokens,
							inputTokens: options.stepTokens,
							outputTokens: 0,
						},
					],
		eventOutbox: {
			flush: async () => {},
			orderedSink: (sink: unknown) => sink,
			inspectRun: async () => ({
				observational: 0,
				terminal: 0,
				blockedPending: options.unsettled ? 1 : 0,
				blockedInMemory: 0,
				inFlight: 0,
			}),
		},
		async emitTraceBundleForRun() {},
	});
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "tedi-1:mcp:req-1",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: originalInput,
		expectedGeneration: 1,
	});
	await agent.onLedgerMirror({
		sessionKey: "main",
		runId: "tedi-1:mcp:req-1",
		user: { role: "user", content: "q", sessionKey: "main", ts: 1 },
		assistant: { role: "assistant", content: "a", sessionKey: "main", ts: 2 },
		...(options.facetUsage ? { facetUsage: options.facetUsage } : {}),
	});
	return events.find((event) => event.kind === "run.completed")?.payload;
}
{
	const facet = await mirror({
		facetUsage: { totalTokens: 50 },
		stepTokens: null,
	});
	assert.equal(facet?.tokensUsed, 50);
	assert.equal(facet?.usage, undefined, "no fabricated usage breakdown");
	const parent = await mirror({ stepTokens: 20 });
	assert.equal(parent?.tokensUsed, 20);
	assert.ok(parent?.usage, "real step telemetry yields the typed breakdown");
	const none = await mirror({ stepTokens: null });
	assert.equal(none?.tokensUsed, undefined, "null-absent, never zero");
	await assert.rejects(
		mirror({ stepTokens: null, unsettled: true }),
		/Original run ledger delivery is unsettled/,
	);
}

// ── mid-turn budget probe and cumulative settlement share one store ─────────
{
	const checks: Array<[string, number]> = [];
	let exhausted = false;
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		inferenceBudgetLimits: () => ({}),
		getInferenceBudgetStore: () => ({
			checkMidTurn(runId: string, _limits: unknown, tokens: number) {
				checks.push([runId, tokens]);
				return exhausted
					? {
							exhausted: true,
							usage: {
								usedTokens: 100,
								dailyTokenLimit: 100,
								admissionClass: "operator",
								day: "2026-09-28",
							},
						}
					: { exhausted: false };
			},
		}),
	});
	assert.deepEqual(
		await agent.checkFacetTurnBudget({
			runId: "run-1",
			cumulativeTokens: 40,
			stepCount: 1,
		}),
		{ abort: false, reason: null },
	);
	exhausted = true;
	const verdict = await agent.checkFacetTurnBudget({
		runId: "run-1",
		cumulativeTokens: 100,
		stepCount: 2,
	});
	assert.equal(verdict.abort, true);
	agent.settleCumulativeInferenceTokens("run-1", 120);
	agent.settleCumulativeInferenceTokens("run-1", undefined);
	assert.deepEqual(checks, [
		["run-1", 40],
		["run-1", 100],
		["run-1", 120],
	]);
}

// The parent has one cognition dispatch surface: ConversationFacet. Native
// provider reservation/recovery/terminal receipts are proved in workerd tests.
{
	const calls: string[] = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		async assertChatTurnActive(id: string) {
			calls.push(`active:${id}`);
		},
		facetDispatchJournal: {
			async enroll(id: string) {
				calls.push(`enroll:${id}`);
			},
		},
	});
	await agent.enrollFacetDispatchRun("run-native");
	assert.deepEqual(calls, ["active:run-native", "enroll:run-native"]);
	const denied = tediDo({
		async assertChatTurnActive() {
			throw new Error("canceled");
		},
		facetDispatchJournal: {
			async enroll() {
				throw new Error("must not enroll");
			},
		},
	});
	await assert.rejects(denied.enrollFacetDispatchRun("run-denied"), /canceled/);
}

// ── the Worker entry exports the facet classes for ctx.exports ───────────────
assert.equal(typeof runtimeWorker.ConversationFacet, "function");

console.log("facet-turn-parent OK");

{
	const refs = [
		{
			key: "__runtime/workflow-images/tedi-1/tedi-1%3Amcp%3Areq-1/hash.json",
			sha256: "hash",
			mediaType: "image/png",
			fileName: "image.png",
		},
	];
	const probe = facetWorkflowTurnProbe();
	await probe.run({ imageRefs: refs });
	assert.deepEqual(probe.facetInputs[0]?.imageRefs, refs);
	assert.equal(
		"images" in probe.facetInputs[0]!,
		false,
		"parent never loads private bytes",
	);
	assert.equal(
		"images" in probe.appends[0]!.turn,
		false,
		"harness rows remain text-only",
	);
}
