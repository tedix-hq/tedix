/** Every pre-dispatch branch that must seal an opened named-cron row, and the
 * terminal settlement, redrive, budget-suppression and orphan paths around it. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import { facetWorkflowTurnProbe, memoryStorage, tediDo } from "../test/tedi-do";
import {
	BillingAdmissionError,
	billingPolicyDeniedWorkflowResult,
} from "./billing-reservation-client";
import { ChatTurnWorkflow } from "./chat-turn-workflow";
import {
	budgetExhaustedWorkflowResult,
	CRON_BUDGET_SUPPRESSION_STORAGE_KEY,
} from "./cron-budget-control";
import { cronTurnMaxSteps } from "./cron-turn-outcome";
import { WORKFLOW_TERMINAL_MAX_REDRIVES } from "./workflow-terminal-reconciliation";
import { DoInferenceBudgetStore } from "./inference-budget-store-do";

const payload = { name: "reflect", message: "Run the reflection cycle." };
const row = { id: "schedule-1", time: 1_700_000_000 };

type Stamp = { phase: string; status?: string; transitions?: unknown };

function cronFireProbe(fields: Record<string, unknown> = {}) {
	const stamps: Stamp[] = [];
	const dispatched: unknown[][] = [];
	const cleared: string[] = [];
	const storage = memoryStorage();
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme" },
		name: "isolate-acme",
		ctx: { storage },
		async cleanupOrphanSchedules() {
			return { orphaned: false };
		},
		async ensureIdentity() {},
		backgroundInferenceBudgetUsage: () => ({}),
		async cronBudgetSuppression() {
			return null;
		},
		async stampCronExecution(stamp: Stamp) {
			stamps.push(stamp);
		},
		async waitUntilStable() {
			return true;
		},
		async getScheduleById() {
			return null;
		},
		async schedule() {
			return { id: "watchdog" };
		},
		async runWorkflow(...args: unknown[]) {
			dispatched.push(args);
		},
		async clearWorkflowDispatch(id: string) {
			cleared.push(id);
		},
		async getPlatformClient() {
			return null;
		},
		...fields,
	});
	// Native cron stability belongs to the session facet, not the parent loop.
	agent.subAgent = async () => ({
		waitUntilStable: (options: unknown) => agent.waitUntilStable(options),
	});
	return { agent, stamps, dispatched, cleared, storage };
}

const finished = (stamps: Stamp[]) =>
	stamps.filter((stamp) => stamp.phase === "finished");

// --- a waitUntilStable throw seals the named execution before rethrow ---
{
	const probe = cronFireProbe({
		async waitUntilStable() {
			throw new Error("stability probe failed");
		},
	});
	await assert.rejects(probe.agent.onCronFire(payload, row), /stability probe/);
	assert.deepEqual(
		probe.stamps.map((stamp) => stamp.phase),
		["started", "finished"],
	);
	assert.equal(finished(probe.stamps)[0]?.status, "failure");
	assert.deepEqual(finished(probe.stamps)[0]?.transitions, {
		dispatched: false,
		stability: "error",
	});
}

// --- a waitUntilStable timeout seals the named execution ---
{
	const probe = cronFireProbe({
		async waitUntilStable() {
			return false;
		},
	});
	const outcome = await probe.agent.onCronFire(payload, row);
	assert.deepEqual(outcome, {
		status: "skipped",
		reason: "conversation_unstable",
	});
	assert.deepEqual(finished(probe.stamps)[0]?.transitions, {
		dispatched: false,
		stability: "timeout",
	});
	assert.equal(probe.dispatched.length, 0);
}

// --- a dispatch-context persistence failure seals and aborts ---
{
	const probe = cronFireProbe();
	probe.storage.put = async () => {
		throw new Error("storage unavailable");
	};
	await assert.rejects(
		probe.agent.onCronFire(payload, row),
		/dispatch context could not be recorded/,
	);
	assert.equal(
		(finished(probe.stamps)[0]?.transitions as { dispatchContext?: string })
			?.dispatchContext,
		"error",
	);
	assert.equal(probe.dispatched.length, 0, "no untrackable workflow launches");
}

// --- a workflow dispatch throw seals the execution before the SDK retry ---
{
	const probe = cronFireProbe({
		async runWorkflow() {
			throw new Error("workflow binding unavailable");
		},
	});
	await assert.rejects(
		probe.agent.onCronFire(payload, row),
		/workflow binding unavailable/,
	);
	assert.equal(
		(finished(probe.stamps)[0]?.transitions as { workflowDispatch?: string })
			?.workflowDispatch,
		"error",
	);
	assert.equal(probe.cleared.length, 1);
}

// --- a healthy fire dispatches one trusted cron workflow ---
{
	const probe = cronFireProbe();
	const outcome = await probe.agent.onCronFire(payload, row);
	assert.equal(outcome.status, "dispatched");
	assert.equal(probe.dispatched.length, 1);
	assert.equal(
		(probe.dispatched[0]?.[1] as { trustedInstructionOrigin?: string })
			.trustedInstructionOrigin,
		"cron",
	);
	assert.deepEqual(finished(probe.stamps), [], "the workflow seals success");
}

// --- a suppressed fire stops before opening a run or execution stamp and
//     reports the budget snapshot ---
{
	const suppression = {
		day: "2026-09-28",
		resetAtMs: Date.now() + 3_600_000,
		backgroundMessageLimit: 10,
		backgroundTokenLimit: 1000,
		usedMessages: 10,
		usedTokens: 1000,
		reason: "background inference budget has no remaining capacity",
	};
	const probe = cronFireProbe({
		async cronBudgetSuppression() {
			return suppression;
		},
	});
	const outcome = await probe.agent.onCronFire(payload, row);
	assert.equal(outcome.status, "suppressed");
	assert.equal(outcome.budget.usedTokens, 1000);
	assert.equal(outcome.budget.tokenLimit, 1000);
	assert.equal(outcome.budget.messageLimit, 10);
	assert.deepEqual(probe.stamps, []);
	assert.equal(probe.dispatched.length, 0);
}

// --- orphan cleanup runs before an empty-message fire can return ---
{
	let cleanups = 0;
	const probe = cronFireProbe({
		async cleanupOrphanSchedules() {
			cleanups += 1;
			return { orphaned: false };
		},
	});
	const outcome = await probe.agent.onCronFire(
		{ name: "empty", message: " " },
		row,
	);
	assert.deepEqual(outcome, { status: "skipped", reason: "empty_message" });
	assert.equal(cleanups, 1);
}

// --- the workflow turn: cron-origin classification, ceilings, tool failure ---
async function workflowTurn(input: {
	trustedInstructionOrigin?: string;
	workItemId?: string;
	assistantText: string;
	toolFailure?: boolean;
}) {
	const { assistantText, toolFailure, ...turn } = input;
	const probe = facetWorkflowTurnProbe({
		async facetTurn() {
			return { assistantText, turnError: null };
		},
		fields: {
			peekPendingToolSteps: () =>
				toolFailure
					? [
							{
								stepNumber: 1,
								finishReason: "facet-tool-error",
								toolNames: ["consolidate"],
								toolResultCount: 1,
							},
						]
					: [],
		},
	});
	return {
		run: probe.run({ sessionKey: "cron:reflect", ...turn }),
		facetInputs: probe.facetInputs,
		commits: probe.commits,
	};
}

{
	// A maintenance cycle keeps the cron ceiling and starts from fresh history;
	// a missing reply is success because its deliverable is tool work.
	const turn = await workflowTurn({
		trustedInstructionOrigin: "cron",
		assistantText: "",
	});
	await turn.run;
	assert.equal(turn.facetInputs[0]?.maxSteps, cronTurnMaxSteps(40));
	assert.equal(turn.facetInputs[0]?.freshHistory, true);
	assert.match(
		String(turn.commits[0]?.assistantText),
		/^Cron maintenance cycle completed/,
	);
}
{
	// A wake (cron lane + Work Item) is real work: its own larger ceiling, and
	// it cannot inherit silent maintenance success.
	const turn = await workflowTurn({
		trustedInstructionOrigin: "cron",
		workItemId: "work-1",
		assistantText: "",
	});
	await assert.rejects(turn.run, /empty_assistant_message/);
	const wakeSteps = Number(turn.facetInputs[0]?.maxSteps);
	assert.ok(wakeSteps > cronTurnMaxSteps(40) && wakeSteps < 40);
}
{
	// An interactive turn gets the governed ceiling and must produce prose.
	const turn = await workflowTurn({ assistantText: "" });
	await assert.rejects(turn.run, /empty_assistant_message/);
	assert.equal(turn.facetInputs[0]?.maxSteps, 40);
	assert.equal(turn.facetInputs[0]?.freshHistory, false);
}
{
	// A fail-soft tool error in a maintenance cycle fails the run even though
	// the model wrote no prose; a Work wake is not replayed as failed maintenance.
	const maintenance = await workflowTurn({
		trustedInstructionOrigin: "cron",
		assistantText: "",
		toolFailure: true,
	});
	await assert.rejects(maintenance.run, /cron_tool_failure/);
	const wake = await workflowTurn({
		trustedInstructionOrigin: "cron",
		workItemId: "work-1",
		assistantText: "Reviewed.",
		toolFailure: true,
	});
	await wake.run;
	assert.equal(wake.commits.length, 1);
}

// --- tool failures are recorded on the durable step buffer ---
for (const finishReason of [
	"facet-tool-error",
	"facet-tool-unavailable",
	"facet-tool-authority-denied",
]) {
	const agent = tediDo({ peekPendingToolSteps: () => [{ finishReason }] });
	assert.equal(agent.runHadFacetToolError("run-1"), true, finishReason);
}
assert.equal(
	tediDo({
		peekPendingToolSteps: () => [{ finishReason: "facet-tool-proxy" }],
	}).runHadFacetToolError("run-1"),
	false,
);

for (const [label, execute, expected] of [
	[
		"resolved fail-soft envelope",
		async () => ({ ok: false }),
		"facet-tool-error",
	],
	["resolved success", async () => ({ ok: true }), "facet-tool-proxy"],
	[
		"thrown error",
		async () => {
			throw new Error("boom");
		},
		"facet-tool-error",
	],
] as const) {
	const completed: string[] = [];
	const returned: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-1" },
		bufferFacetToolCall: () => 1,
		activeFacetTurnTools: new Map([["run-1", { probe: { execute } }]]),
		activeFacetTurnAuthorities: new Map(),
		activeFacetTurnConversations: new Map(),
		facetDispatchJournal: {
			claim: async () => true,
			markReturned: async (_call: unknown, reason: string) => {
				returned.push(reason);
			},
		},
		nativeToolLedger: {
			observe: (_context: unknown, _call: unknown, run: () => unknown) => run(),
		},
		async completeFacetToolCall(call: { finishReason: string }) {
			completed.push(call.finishReason);
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
	assert.deepEqual(completed, [expected], label);
	assert.deepEqual(returned, [expected], `${label}: terminal receipt`);
}

// --- terminal reconciliation: redrive transient resets, bounded ---
async function reconcileProbe(
	context: Record<string, unknown>,
	status: unknown,
	options: { admitted?: boolean; exhausted?: boolean } = {},
) {
	const calls: string[] = [];
	const storage = memoryStorage({ "wfctx:wf-1": context });
	// Keep the original durable inference admission real; a process-local active
	// map or a reset error alone is not proof that another attempt is permitted.
	const db = new Database(":memory:");
	const budget = new DoInferenceBudgetStore({
		sql<T>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			const query = strings.reduce(
				(text, part, index) => text + part + (index < values.length ? "?" : ""),
				"",
			);
			return db.query(query).all(...values) as T[];
		},
	});
	const limits = {
		dailyMessageLimit: 2,
		dailyTokenLimit: 100,
		operatorMessageReserve: 0,
		operatorTokenReserve: 0,
		governedLearningMessageReserve: 0,
		governedLearningTokenReserve: 0,
	};
	if (options.admitted !== false)
		budget.admit(String(context.runId), limits, 1);
	if (options.exhausted) limits.dailyTokenLimit = 0;
	const agent = tediDo({
		ctx: { storage },
		getInferenceBudgetStore: () => budget,
		inferenceBudgetLimits: () => limits,
		async getWorkflowStatus() {
			return status;
		},
		async restartWorkflow(id: string, options: unknown) {
			calls.push(`restart:${id}:${JSON.stringify(options)}`);
		},
		async schedule(_delay: number, callback: string) {
			calls.push(`schedule:${callback}`);
		},
		async settleWorkflowFailure(id: string, error: string) {
			calls.push(`fail:${id}:${error}`);
		},
		async onWorkflowComplete(_name: string, id: string) {
			calls.push(`complete:${id}`);
		},
	});
	if (options.admitted !== false)
		await agent.runtimeAdmission().beginAcceptedTurn({
			runId: String(context.runId),
			sessionKey: String(context.sessionKey ?? "main"),
			principalId: agent.state.tediId,
			input: context,
			expectedGeneration: 1,
		});
	return { agent, calls, storage };
}
for (const options of [{ exhausted: true }, { admitted: false }]) {
	const probe = await reconcileProbe(
		{ runId: "run-1", sessionKey: "main" },
		{
			status: "errored",
			error: { message: "Durable Object reset because its code was updated" },
		},
		options,
	);
	await probe.agent.reconcileChatWorkflowTerminalInner({
		workflowInstanceId: "wf-1",
		attempt: 0,
	});
	assert.deepEqual(
		probe.calls,
		["fail:wf-1:Durable Object reset because its code was updated"],
		"exhausted or absent original admission must not restart or rearm",
	);
}
{
	const probe = await reconcileProbe(
		{ runId: "run-1", sessionKey: "main" },
		{
			status: "errored",
			error: { message: "Durable Object reset because its code was updated" },
		},
	);
	await probe.agent.reconcileChatWorkflowTerminalInner({
		workflowInstanceId: "wf-1",
		attempt: 0,
	});
	assert.deepEqual(probe.calls, [
		'restart:wf-1:{"resetTracking":false}',
		"schedule:reconcileChatWorkflowTerminal",
	]);
	assert.equal(
		(probe.storage.data.get("wfctx:wf-1") as { redriveCount?: number })
			.redriveCount,
		1,
	);
}
{
	const probe = await reconcileProbe(
		{ runId: "run-1", redriveCount: WORKFLOW_TERMINAL_MAX_REDRIVES },
		{
			status: "errored",
			error: { message: "Durable Object reset because its code was updated" },
		},
	);
	await probe.agent.reconcileChatWorkflowTerminalInner({
		workflowInstanceId: "wf-1",
		attempt: 0,
	});
	assert.equal(probe.calls.length, 1);
	assert.match(
		probe.calls[0]!,
		/^fail:wf-1:/,
		"exhausted redrives seal failure",
	);
}
{
	const probe = await reconcileProbe(
		{ runId: "run-1" },
		{ status: "errored", error: { message: "model refused" } },
	);
	await probe.agent.reconcileChatWorkflowTerminalInner({
		workflowInstanceId: "wf-1",
		attempt: 0,
	});
	assert.deepEqual(probe.calls, ["fail:wf-1:model refused"]);
}

// --- budget and billing stops: suppress later fires, settle the run failed
//     with the assistant fallback, never as success ---
const budgetStop = budgetExhaustedWorkflowResult(
	new Error("Inference daily budget exhausted for tedi-1"),
);
const billingStop = billingPolicyDeniedWorkflowResult(
	new BillingAdmissionError("hard_spend_limit", "spend limit reached"),
)!;
for (const result of [budgetStop, billingStop]) {
	const settled: unknown[][] = [];
	const storage = memoryStorage({
		"wfctx:wf-1": {
			runId: "run-1",
			cron: { name: "reflect", fireKey: "cron:x", startedAtIso: "t" },
		},
	});
	const agent = tediDo({
		ctx: { storage },
		backgroundInferenceBudgetUsage: () => ({}),
		async settleWorkflowFailure(...args: unknown[]) {
			settled.push(args);
		},
		async settleWorkflowSuccess() {
			throw new Error("a budget or billing stop is not success");
		},
	});
	await agent.onWorkflowComplete("CHAT_TURN_WORKFLOW", "wf-1", result);
	assert.ok(storage.data.has(CRON_BUDGET_SUPPRESSION_STORAGE_KEY));
	assert.equal(settled.length, 1);
	assert.equal(settled[0]?.[1], result.error);
	if (result === billingStop)
		assert.deepEqual(settled[0]?.[2], { assistantText: billingStop.text });
}

// --- the Workflow converts a deterministic budget or billing rejection into
//     a typed terminal result instead of burning transient retries ---
for (const [error, expected] of [
	[new Error("Inference daily budget exhausted for tedi-1"), budgetStop],
	[
		new BillingAdmissionError("hard_spend_limit", "spend limit reached"),
		billingStop,
	],
] as const) {
	let attempts = 0;
	const completed: unknown[] = [];
	const workflow = Object.create(ChatTurnWorkflow.prototype) as InstanceType<
		typeof ChatTurnWorkflow
	>;
	Object.defineProperty(workflow, "agent", {
		value: {
			markChatWorkflowStarted: async () => true,
			runFacetWorkflowTurn: async () => {
				attempts += 1;
				throw error;
			},
		},
	});
	const result = await workflow.run(
		{
			instanceId: "wf-1",
			payload: {
				runId: "run-1",
				sessionKey: "cron:reflect",
				conversationId: "conversation",
				userText: "Run the reflection cycle.",
				userTs: 0,
				clientRequestId: "cron:x",
			},
		} as Parameters<typeof workflow.run>[0],
		{
			async do(_name: string, _config: unknown, callback: () => unknown) {
				return callback();
			},
			async sleep() {},
			async reportComplete(value: unknown) {
				completed.push(value);
			},
		} as unknown as Parameters<typeof workflow.run>[1],
	);
	assert.equal(attempts, 1);
	assert.equal(result.stopReason, expected.stopReason);
	assert.equal(result.error, expected.error);
	assert.equal(completed.length, 1);
}

// --- failure settlement commits the keyed fallback before clearing the
//     dispatch record, and mirrors it into the failed ledger chain ---
{
	const order: string[] = [];
	const storage = memoryStorage({
		"wfctx:wf-1": {
			runId: "run-1",
			sessionKey: "main",
			userText: "hello",
			userTs: 1,
			cron: { name: "reflect", fireKey: "cron:x", startedAtIso: "t" },
		},
	});
	const agent = tediDo({
		ctx: { storage },
		sessionHarness: {
			async appendTurn(_sessionKey: string, _turn: unknown, key: string) {
				order.push(`append:${key}`);
				return true;
			},
		},
		async stampCronExecution(stamp: Stamp) {
			order.push(`stamp:${stamp.status}`);
		},
		async mirrorFailedTurn(input: { assistant?: { content: string } }) {
			order.push(`mirror:${input.assistant?.content}`);
		},
		async clearWorkflowDispatch() {
			order.push("clear");
		},
	});
	await agent.mirrorWorkflowFailure("wf-1", "boom", "The turn failed.");
	assert.deepEqual(order, [
		`append:${deriveIdempotencyKey("run-1", "assistant")}`,
		"stamp:failure",
		"mirror:The turn failed.",
		"clear",
	]);
}

// --- orphaned-DO self-heal ---
function orphanProbe(options: {
	state?: Record<string, unknown>;
	canonical?: { isolateAgentId: string } | null;
	name?: string;
	cancel?: (id: string) => Promise<boolean>;
	remaining?: string[];
}) {
	const cancelled: string[] = [];
	let dbReads = 0;
	const schedules = [
		{ id: "cron-row", callback: "onCronFire" },
		{ id: "maintenance-row", callback: "isolate-brain-digest" },
	];
	const agent = tediDo({
		name: options.name ?? "isolate-acme",
		ctx: { id: { toString: () => "opaque-id" } },
		state: options.state ?? { tediId: "tedi-1", slug: "acme" },
		env: {
			DB: {
				prepare: () => ({
					bind: () => ({
						first: async () => {
							dbReads += 1;
							return options.canonical === undefined
								? { isolateAgentId: "isolate-acme" }
								: options.canonical;
						},
					}),
				}),
			},
		},
		async listSchedules() {
			return cancelled.length > 0
				? (options.remaining ?? []).map((id) => ({ id }))
				: schedules;
		},
		async cancelSchedule(id: string) {
			cancelled.push(id);
			return options.cancel ? options.cancel(id) : true;
		},
		async getScheduleById() {
			return null;
		},
	});
	return { agent, cancelled, reads: () => dbReads };
}
{
	// The canonical DO is never touched.
	const probe = orphanProbe({});
	const result = await probe.agent.cleanupOrphanSchedules();
	assert.equal(result.orphaned, false);
	assert.deepEqual(probe.cancelled, []);
}
{
	// A hard-deleted tedi row proves the orphan; every schedule class goes,
	// framework maintenance included.
	const probe = orphanProbe({ canonical: null });
	const result = await probe.agent.cleanupOrphanSchedules();
	assert.equal(result.orphaned, true);
	assert.deepEqual(probe.cancelled, ["cron-row", "maintenance-row"]);
	assert.deepEqual(result.cancelledScheduleIds, [
		"cron-row",
		"maintenance-row",
	]);
}
{
	// A rebind to another DO is also proof.
	const probe = orphanProbe({ canonical: { isolateAgentId: "isolate-new" } });
	assert.equal((await probe.agent.cleanupOrphanSchedules()).orphaned, true);
}
{
	// Missing identity and a slug outside the operator allowlist are skipped
	// before any canonical lookup or cancellation.
	const noIdentity = orphanProbe({ state: {}, canonical: null });
	assert.equal(
		(await noIdentity.agent.cleanupOrphanSchedules()).skippedReason,
		"identity_missing",
	);
	const mismatch = orphanProbe({ canonical: null });
	assert.equal(
		(await mismatch.agent.cleanupOrphanSchedules({ expectedSlugs: ["other"] }))
			.skippedReason,
		"slug_mismatch",
	);
	assert.equal(noIdentity.reads() + mismatch.reads(), 0);
	assert.deepEqual([...noIdentity.cancelled, ...mismatch.cancelled], []);
}
{
	// A legacy unnamed object confirms a throwing cancel through the public
	// scheduler API; a named object records it as failed.
	const legacy = orphanProbe({
		canonical: null,
		name: "opaque-id",
		async cancel() {
			throw new Error("schedule:cancel event failed");
		},
	});
	const legacyResult = await legacy.agent.cleanupOrphanSchedules();
	assert.deepEqual(legacyResult.cancelledScheduleIds, [
		"cron-row",
		"maintenance-row",
	]);
	const named = orphanProbe({
		canonical: null,
		async cancel() {
			throw new Error("schedule:cancel event failed");
		},
	});
	assert.deepEqual(
		(await named.agent.cleanupOrphanSchedules()).failedScheduleIds,
		["cron-row", "maintenance-row"],
	);
}
{
	// An orphaned DO skips its cron fire.
	const probe = orphanProbe({ canonical: null });
	probe.agent.ensureIdentity = async () => {
		throw new Error("an orphan must not resolve identity or fire");
	};
	assert.deepEqual(await probe.agent.onCronFire(payload, row), {
		status: "skipped",
		reason: "orphaned_runtime",
	});
}

// --- the parent callback delegates to native maintenance services ---
{
	const calls: unknown[] = [];
	const maintenancePayload = { taskId: "isolate-daily-log-flush" as const };
	const maintenanceSchedule = {
		id: "maintenance-fire-1",
		time: row.time,
		callback: "onParentMaintenance",
		payload: maintenancePayload,
		type: "scheduled" as const,
	};
	const native = tediDo({
		maintenance: {
			async run(payload: unknown, schedule: unknown) {
				calls.push({ payload, schedule });
			},
		},
	});
	await native.onParentMaintenance(maintenancePayload, maintenanceSchedule);
	assert.deepEqual(calls, [
		{ payload: maintenancePayload, schedule: maintenanceSchedule },
	]);
}

console.log("cron-terminal-wiring.test.ts: all assertions passed");
