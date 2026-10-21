import assert from "node:assert/strict";
import { memoryStorage, tediDo } from "../test/tedi-do";
import { ComputerCodeRouting } from "./computer-codemode-routing";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";
import {
	durableCodeCorrelationKey,
	type DurableCodeRunCorrelation,
} from "./durable-codemode-lifecycle";

/**
 * Characterises who may approve, reject and roll back a durable Code Mode
 * execution, and which transitions the tedi's tool authority accepts.
 *
 * Caller identity is decided before these methods run: the MCP mount only
 * offers approve/reject/rollback when `canManageDurableCode` allowed the
 * caller (`durable-code-delegation.test.ts`), and `/__admin/durable-code/resolve`
 * requires admin authorization. The methods themselves are reached only on the
 * tedi's own Durable Object, so their boundary is that DO's storage: an
 * execution id this tedi never recorded or ran cannot be resolved.
 */

type Status =
	| "running"
	| "paused"
	| "completed"
	| "error"
	| "rejected"
	| "rolled_back";
type Entry = {
	seq: number;
	connector: string;
	method: string;
	state: "pending" | "executing" | "applied" | "reverted";
	revertible: boolean;
};
type FakeExecution = { id: string; status: Status; log: Entry[] };

/**
 * A runtime double that mirrors the Code Mode SDK's state machine: approve
 * resumes only a paused run (atomically flipping it to running), reject only
 * ends a pending action, and rollback reverts applied actions and marks the
 * run rolled back when anything reverted.
 */
function fakeRuntime() {
	const executions = new Map<string, FakeExecution>();
	const calls: string[] = [];
	return {
		executionsById: executions,
		calls,
		seed(execution: FakeExecution) {
			executions.set(execution.id, execution);
		},
		async executions() {
			return [...executions.values()].map((execution) => ({
				id: execution.id,
				code: "async () => null",
				status: execution.status,
				log: execution.log.map((entry) => ({
					...entry,
					args: {},
					requiresApproval: true,
				})),
				createdAt: 1,
				updatedAt: 1,
			}));
		},
		async approve({ executionId }: { executionId: string }) {
			calls.push(`approve:${executionId}`);
			const execution = executions.get(executionId);
			if (!execution || execution.status !== "paused")
				return {
					status: "error" as const,
					executionId,
					error: execution
						? `Execution "${executionId}" is not paused (status: ${execution.status}); only a paused run can be approved.`
						: `No execution "${executionId}" to resume.`,
				};
			execution.status = "running";
			const pending = execution.log.find((entry) => entry.state === "pending");
			if (pending) pending.state = "applied";
			const next = execution.log.find(
				(entry) =>
					entry.state === "executing" && entry.seq > (pending?.seq ?? -1),
			);
			if (next) {
				next.state = "pending";
				execution.status = "paused";
				return {
					status: "paused" as const,
					executionId,
					pending: [
						{
							executionId,
							seq: next.seq,
							connector: next.connector,
							method: next.method,
							args: {},
						},
					],
				};
			}
			execution.status = "completed";
			return { status: "completed" as const, executionId, result: "done" };
		},
		async reject({ executionId, seq }: { executionId: string; seq: number }) {
			calls.push(`reject:${executionId}:${seq}`);
			const execution = executions.get(executionId);
			const entry = execution?.log.find((item) => item.seq === seq);
			if (!execution || entry?.state !== "pending") return false;
			entry.state = "reverted";
			execution.status = "rejected";
			return true;
		},
		async rollback({ executionId }: { executionId: string }) {
			calls.push(`rollback:${executionId}`);
			const execution = executions.get(executionId);
			let reverted = 0;
			for (const entry of [...(execution?.log ?? [])].reverse()) {
				if (entry.state !== "applied" || !entry.revertible) continue;
				entry.state = "reverted";
				reverted++;
			}
			if (execution && reverted > 0) execution.status = "rolled_back";
		},
	};
}

type FakeRuntime = ReturnType<typeof fakeRuntime>;
const OPERATOR: ComputerWorkspaceScope = { kind: "operator", key: "operator" };
const CONVERSATION: ComputerWorkspaceScope = {
	kind: "conversation",
	key: "session-a",
};
const scopeKey = (scope: { kind: string; key: string }) =>
	`${scope.kind}:${scope.key}`;

function harness(options: { tediId?: string | null } = {}) {
	const storage = memoryStorage();
	const runtimes = new Map<string, FakeRuntime>([
		[scopeKey(OPERATOR), fakeRuntime()],
		[scopeKey(CONVERSATION), fakeRuntime()],
	]);
	const runtimeFor = async (scope: { kind: string; key: string }) => {
		const runtime = runtimes.get(scopeKey(scope));
		if (!runtime) throw new Error(`no runtime for ${scopeKey(scope)}`);
		return runtime;
	};
	const events: Array<Record<string, any>> = [];
	const proposals: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		state:
			options.tediId === null
				? {}
				: {
						tediId: options.tediId ?? "tedi-unit-a",
						orgId: "org-unit-a",
						slug: "unit-a",
					},
		ctx: { storage },
		eventOutbox: {
			publish: async (event: Record<string, any>) => events.push(event),
			publishTerminal: async (event: Record<string, any>) => events.push(event),
		},
		computerCodeRouting: new ComputerCodeRouting(
			storage as unknown as ConstructorParameters<
				typeof ComputerCodeRouting
			>[0],
			runtimeFor,
		),
		getDurableCodemodeRuntime: runtimeFor,
		proposeCodemodeExecuteApproval: async (input: Record<string, unknown>) => {
			proposals.push(input);
			return null;
		},
	});
	async function seed(
		scope: ComputerWorkspaceScope,
		execution: FakeExecution,
		record = true,
	) {
		(await runtimeFor(scope)).seed(execution);
		await storage.put(
			`durable-code:registered-workspace:${scopeKey(scope)}`,
			scope,
		);
		if (record) await agent.computerCodeRouting.record(execution.id, scope);
	}
	return {
		agent,
		storage,
		events,
		proposals,
		seed,
		runtime: (scope: ComputerWorkspaceScope) => runtimes.get(scopeKey(scope))!,
	};
}

const pausedAt = (id: string, seq = 0): FakeExecution => ({
	id,
	status: "paused",
	log: [
		{
			seq,
			connector: "mcp",
			method: "call_tool",
			state: "pending",
			revertible: true,
		},
	],
});
const finished = (id: string, status: Status): FakeExecution => ({
	id,
	status,
	log: [
		{
			seq: 0,
			connector: "mcp",
			method: "call_tool",
			state: "applied",
			revertible: true,
		},
	],
});

async function captureConsole<T>(run: () => Promise<T>) {
	const logged: unknown[] = [];
	const { error, warn } = console;
	console.error = (...args: unknown[]) => logged.push(args[0]);
	console.warn = (...args: unknown[]) => logged.push(args[0]);
	try {
		return { value: await run(), logged };
	} finally {
		console.error = error;
		console.warn = warn;
	}
}

// Approve: a paused execution runs its pending action exactly once; a replay
// of the same approval is refused by the runtime and runs nothing again.
{
	const { agent, seed, runtime, events } = harness();
	await seed(OPERATOR, pausedAt("exec-approve"));
	const first = await agent.approveDurableCodeExecution("exec-approve");
	assert.equal(first.status, "completed");
	const replay = await agent.approveDurableCodeExecution("exec-approve");
	assert.equal(replay.status, "error");
	assert.match(replay.error, /not paused \(status: completed\)/);
	const execution = runtime(OPERATOR).executionsById.get("exec-approve")!;
	assert.deepEqual(
		execution.log.map((entry) => entry.state),
		["applied"],
	);
	assert.equal(execution.status, "completed");
	// Both attempts are projected; only the successful one resolves the run.
	assert.deepEqual(
		events
			.filter((event) => event.payload?.surface === "durable_codemode")
			.map((event) => [event.kind, event.payload.status ?? null]),
		[
			["tool.completed", "completed"],
			["approval.resolved", "approved"],
			["run.completed", null],
			["tool.failed", "error"],
		],
	);
}

// Approve after reject, or of a run that never paused, is refused.
{
	const { agent, seed } = harness();
	await seed(OPERATOR, finished("exec-rejected", "rejected"));
	await seed(OPERATOR, finished("exec-done", "completed"));
	for (const id of ["exec-rejected", "exec-done"]) {
		const result = await agent.approveDurableCodeExecution(id);
		assert.equal(result.status, "error");
	}
}

// Approve that pauses again re-bridges the next action to the same Home run,
// reusing the stable approval request for a replayed pause at the same step.
{
	const { agent, seed, storage, proposals } = harness();
	const execution = pausedAt("exec-chain");
	execution.log.push({
		seq: 1,
		connector: "mcp",
		method: "call_tool",
		state: "executing",
		revertible: true,
	});
	await seed(CONVERSATION, execution);
	const correlation: DurableCodeRunCorrelation = {
		codeHash: "hash-a",
		conversationId: "conv-a",
		runId: "child-run-a",
		sessionKey: "session-a",
		homeRunId: "home-run-a",
	};
	await storage.put(durableCodeCorrelationKey("exec-chain"), correlation);
	const result = await agent.approveDurableCodeExecution("exec-chain");
	assert.equal(result.status, "paused");
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0]!.pendingSeq, 1);
	assert.equal(proposals[0]!.homeRunId, "home-run-a");
	assert.equal(proposals[0]!.executionId, "exec-chain");
	const stored = await storage.get<DurableCodeRunCorrelation>(
		durableCodeCorrelationKey("exec-chain"),
	);
	assert.equal(stored?.approvalPendingSeq, 1);
	assert.equal(stored?.approvalRequestId, proposals[0]!.approvalRequestId);
}

// Without a Home correlation an approval that pauses again bridges nothing.
{
	const { agent, seed, proposals } = harness();
	const execution = pausedAt("exec-local");
	execution.log.push({
		seq: 1,
		connector: "mcp",
		method: "call_tool",
		state: "executing",
		revertible: true,
	});
	await seed(OPERATOR, execution);
	assert.equal(
		(await agent.approveDurableCodeExecution("exec-local")).status,
		"paused",
	);
	assert.equal(proposals.length, 0);
}

// Reject: ends a paused run once; a replay or a stale seq changes nothing.
{
	const { agent, seed, runtime, events } = harness();
	await seed(OPERATOR, pausedAt("exec-reject", 2));
	assert.deepEqual(await agent.rejectDurableCodeExecution("exec-reject", 7), {
		ok: false,
		execution_id: "exec-reject",
		seq: 7,
	});
	assert.equal(
		runtime(OPERATOR).executionsById.get("exec-reject")!.status,
		"paused",
	);
	assert.equal(
		(await agent.rejectDurableCodeExecution("exec-reject", 2)).ok,
		true,
	);
	assert.equal(
		(await agent.rejectDurableCodeExecution("exec-reject", 2)).ok,
		false,
	);
	assert.equal(
		runtime(OPERATOR).executionsById.get("exec-reject")!.status,
		"rejected",
	);
	assert.deepEqual(
		events.map((event) => event.payload.status ?? event.kind),
		["unchanged", "rejected", "rejected", "run.canceled", "unchanged"],
	);
}

// Reject after approve: the action already ran, so the reject is a no-op.
{
	const { agent, seed, runtime } = harness();
	await seed(OPERATOR, pausedAt("exec-approved"));
	await agent.approveDurableCodeExecution("exec-approved");
	assert.equal(
		(await agent.rejectDurableCodeExecution("exec-approved", 0)).ok,
		false,
	);
	assert.equal(
		runtime(OPERATOR).executionsById.get("exec-approved")!.status,
		"completed",
	);
}

// Reject refuses a stale pending entry left on a run that is no longer paused:
// only a paused run has an actionable approval, so a terminal outcome is never
// rewritten as rejected.
{
	const { agent, seed, runtime } = harness();
	const stale = pausedAt("exec-stale");
	stale.status = "error";
	await seed(OPERATOR, stale);
	assert.equal(
		(await agent.rejectDurableCodeExecution("exec-stale", 0)).ok,
		false,
	);
	assert.equal(
		runtime(OPERATOR).executionsById.get("exec-stale")!.status,
		"error",
	);
	assert.deepEqual(runtime(OPERATOR).calls, []);
}

// Rollback: a finished run's applied actions revert in reverse order, and a
// rejected run can be rolled back to undo actions applied before the reject.
{
	const { agent, seed, runtime, events } = harness();
	await seed(OPERATOR, finished("exec-roll", "completed"));
	await seed(OPERATOR, finished("exec-roll-rejected", "rejected"));
	await seed(OPERATOR, finished("exec-roll-error", "error"));
	for (const id of ["exec-roll", "exec-roll-rejected", "exec-roll-error"]) {
		assert.deepEqual(await agent.rollbackDurableCodeExecution(id), {
			ok: true,
			execution_id: id,
		});
		assert.equal(
			runtime(OPERATOR).executionsById.get(id)!.status,
			"rolled_back",
		);
	}
	assert.ok(
		events.some(
			(event) =>
				event.payload?.action === "rollback" &&
				event.payload.status === "rolled_back",
		),
	);
	// A retry after a partial rollback only runs compensations that remain.
	assert.deepEqual(await agent.rollbackDurableCodeExecution("exec-roll"), {
		ok: true,
		execution_id: "exec-roll",
	});
}

// Rollback refuses a run that is still paused or running. Reverting under a
// live run would let its pending approval resume afterwards, or let an
// in-flight pass complete over the rollback.
for (const status of ["paused", "running"] as const) {
	const { agent, seed, runtime, events } = harness();
	const execution = pausedAt(`exec-${status}`);
	execution.status = status;
	execution.log.unshift({
		seq: -1,
		connector: "mcp",
		method: "call_tool",
		state: "applied",
		revertible: true,
	});
	await seed(OPERATOR, execution);
	await assert.rejects(
		agent.rollbackDurableCodeExecution(`exec-${status}`),
		new RegExp(`still ${status}`),
	);
	assert.deepEqual(runtime(OPERATOR).calls, []);
	assert.equal(execution.log[0]!.state, "applied");
	assert.equal(events.length, 0);
}

// Rollback refuses an execution its workspace runtime no longer has, rather
// than reporting a rollback that reverted nothing.
{
	const { agent, seed, runtime } = harness();
	await seed(OPERATOR, finished("exec-pruned", "completed"));
	runtime(OPERATOR).executionsById.delete("exec-pruned");
	await assert.rejects(
		agent.rollbackDurableCodeExecution("exec-pruned"),
		/execution_not_found/,
	);
	assert.deepEqual(runtime(OPERATOR).calls, []);
}

// Unknown ids, and ids belonging to another tedi or organization, cannot be
// resolved: execution ownership lives in this tedi's own DO storage, so no
// runtime is touched and no event is recorded.
{
	const tediA = harness({ tediId: "tedi-unit-a" });
	const tediB = harness({ tediId: "tedi-unit-b" });
	await tediB.seed(OPERATOR, pausedAt("exec-of-b"));
	await tediA.seed(OPERATOR, finished("exec-of-a", "completed"));
	for (const run of [
		() => tediA.agent.approveDurableCodeExecution("exec-of-b"),
		() => tediA.agent.rejectDurableCodeExecution("exec-of-b", 0),
		() => tediA.agent.rollbackDurableCodeExecution("exec-of-b"),
		() => tediA.agent.approveDurableCodeExecution("exec-unknown"),
	]) {
		await assert.rejects(run(), /workspace is unavailable/);
	}
	await assert.rejects(
		tediA.agent.approveDurableCodeExecution(""),
		/execution ID is required/,
	);
	assert.deepEqual(tediA.runtime(OPERATOR).calls, []);
	assert.equal(tediA.events.length, 0);
	assert.equal(
		tediB.runtime(OPERATOR).executionsById.get("exec-of-b")!.status,
		"paused",
	);
}

// An unrecorded id is routed to the one registered workspace that owns it, and
// the ownership is then pinned; ambiguous ownership is refused.
{
	const { agent, seed, runtime, storage } = harness();
	await seed(CONVERSATION, pausedAt("exec-unrecorded"), false);
	await seed(OPERATOR, finished("exec-other", "completed"), false);
	assert.equal(
		(await agent.approveDurableCodeExecution("exec-unrecorded")).status,
		"completed",
	);
	assert.deepEqual(
		await storage.get("durable-code:workspace:exec-unrecorded"),
		CONVERSATION,
	);
	assert.deepEqual(runtime(OPERATOR).calls, []);

	runtime(OPERATOR).seed(pausedAt("exec-twice"));
	runtime(CONVERSATION).seed(pausedAt("exec-twice"));
	await assert.rejects(
		agent.approveDurableCodeExecution("exec-twice"),
		/ambiguous workspace ownership/,
	);
}

// Event projection: a run correlated to a turn reports under that turn's ids.
{
	const { agent, seed, storage, events } = harness();
	await seed(CONVERSATION, finished("exec-correlated", "completed"));
	await storage.put(durableCodeCorrelationKey("exec-correlated"), {
		conversationId: "conv-b",
		runId: "run-b",
		sessionKey: "session-a",
		homeRunId: "home-run-b",
	} satisfies DurableCodeRunCorrelation);
	await agent.recordDurableCodemodeResult({
		action: "approve",
		executionId: "exec-correlated",
		result: { status: "completed" },
		status: "completed",
	});
	assert.deepEqual(
		events.map((event) => [event.kind, event.runId, event.conversationId]),
		[
			["tool.completed", "run-b", "conv-b"],
			["approval.resolved", "run-b", "conv-b"],
			["run.completed", "run-b", "conv-b"],
		],
	);
	assert.equal(events[1]!.payload.homeRunId, "home-run-b");
	assert.equal(events[0]!.tediId, "tedi-unit-a");
}

// Without a correlation, the run id and conversation derive from the tedi and
// the execution's workspace.
{
	const { agent, seed, events } = harness();
	await seed(CONVERSATION, finished("exec-plain", "completed"));
	await agent.recordDurableCodemodeResult({
		action: "rollback",
		executionId: "exec-plain",
		result: { ok: true },
		status: "rolled_back",
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]!.runId, "tedi-unit-a:durable-code:exec-plain");
	assert.equal(events[0]!.payload.action, "rollback");
}

// Projection failure is logged and never thrown: the action already happened.
{
	const { agent, events } = harness();
	const { logged } = await captureConsole(() =>
		agent.recordDurableCodemodeResult({
			action: "approve",
			executionId: "exec-unrouted",
			result: {},
			status: "completed",
		}),
	);
	assert.equal(events.length, 0);
	assert.ok(
		logged.some(
			(entry) =>
				(entry as { event?: string }).event ===
				"tedi.codemode.event_projection_failed",
		),
	);
}

// A failing outbox is logged per event and does not fail the approval.
{
	const { agent, seed } = harness();
	agent.eventOutbox = {
		publish: async () => {
			throw new Error("outbox down");
		},
		publishTerminal: async () => {
			throw new Error("outbox down");
		},
	};
	await seed(OPERATOR, pausedAt("exec-outbox"));
	const { value, logged } = await captureConsole<{ status: string }>(() =>
		agent.approveDurableCodeExecution("exec-outbox"),
	);
	assert.equal(value.status, "completed");
	assert.ok(
		logged.some(
			(entry) =>
				(entry as { event?: string }).event ===
				"tedi.durable_codemode_event_publish_failed",
		),
	);
}

// A DO with no tedi identity projects nothing.
{
	const { agent, events } = harness({ tediId: null });
	await agent.recordDurableCodemodeResult({
		action: "run",
		executionId: "exec-anon",
		result: {},
	});
	assert.equal(events.length, 0);
}

// Browser egress denial: logged and recorded with the denied host.
{
	const recorded: Array<Record<string, any>> = [];
	const agent = tediDo({
		resolveTurnTelemetry: async () => ({
			tediId: "tedi-unit-a",
			runId: "run-egress",
			conversationId: "conv-egress",
			platform: {
				recordRuntimeEvent: async (event: Record<string, any>) =>
					recorded.push(event),
			},
		}),
	});
	const { logged } = await captureConsole(() =>
		agent.recordBrowserEgressDenial(
			"browser_navigate",
			{ hostname: "blocked.example.test", reason: "hostname_blocked" },
			null,
		),
	);
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]!.kind, "browser.egress.deny");
	assert.equal(recorded[0]!.runId, "run-egress");
	assert.match(recorded[0]!.id, /^run-egress:browser-egress:/);
	assert.deepEqual(recorded[0]!.payload, {
		toolName: "browser_navigate",
		hostname: "blocked.example.test",
		reason: "hostname_blocked",
	});
	assert.ok(
		logged.some((entry) => String(entry).includes("host=blocked.example.test")),
	);
}

// Egress denial without turn telemetry, or with a failing recorder, only logs.
{
	const noTurn = tediDo({ resolveTurnTelemetry: async () => null });
	const { logged: quiet } = await captureConsole(() =>
		noTurn.recordBrowserEgressDenial(
			"browser_navigate",
			{ hostname: null, reason: "uninspectable" },
			null,
		),
	);
	assert.ok(quiet.some((entry) => String(entry).includes("uninspectable")));

	const failing = tediDo({
		resolveTurnTelemetry: async () => ({
			tediId: "tedi-unit-a",
			runId: "run-egress",
			conversationId: "conv-egress",
			platform: {
				recordRuntimeEvent: async () => {
					throw new Error("audit down");
				},
			},
		}),
	});
	const { logged } = await captureConsole(() =>
		failing.recordBrowserEgressDenial(
			"browser_navigate",
			{ hostname: "blocked.example.test", reason: "hostname_blocked" },
			null,
		),
	);
	assert.ok(
		logged.some(
			(entry) =>
				(entry as { event?: string }).event ===
				"tedi.browser.egress_denial_audit_failed",
		),
	);
}

console.log("runtime tool authority durable code characterization passed");
