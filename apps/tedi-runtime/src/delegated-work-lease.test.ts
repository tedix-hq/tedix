import { RpcCallError } from "@tedix/api-client/internal";
import assert from "node:assert/strict";
import {
	decideWorkflowTerminalReconciliation,
	WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS,
} from "./workflow-terminal-reconciliation";
import { hasPendingComputerExecutions } from "./computer-workflow-continuation";
import {
	DELEGATED_WORK_LEASE_RENEWAL_DEADLINE_MS,
	DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS,
	type DelegatedWorkLeaseDeps,
	type DelegatedWorkLeaseRenewal,
	renewDelegatedWorkLease,
	observeDelegatedWorkLeaseWorkflow,
	validateDelegatedWorkLeaseWorkflow,
	reconcileWorkflowOnce,
	delegatedWorkLeaseTerminalKey,
	withDelegatedWorkLease,
} from "./delegated-work-lease";

type LeaseClient = NonNullable<
	Awaited<ReturnType<DelegatedWorkLeaseDeps["getClient"]>>
>;

const input = {
	runId: "run-1",
	sessionKey: "agent:main:main",
	workItemId: "work-1",
	homeRunId: "home-1",
};
const RENEWAL_KEY = "workleaserenew:run-1";
/** The production Work Attempt lease this renewal has to stay ahead of. */
const LEASE_MS = 300_000;
const INTERVAL_MS = DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS * 1000;

/**
 * Durable storage plus a hand-driven alarm: the whole point of the fixture is
 * that NOTHING advances renewal from inside the invocation that holds the
 * lease. Ticks are driven by `tick()`, which is the DO's alarm callback, and
 * each one builds fresh renewal deps from the same storage — a new isolate.
 */
function fixture(
	observeWorkflow?: (record: DelegatedWorkLeaseRenewal) => Promise<boolean>,
) {
	const rows = new Map<string, unknown>();
	let canceled = false;
	let settled = false;
	let heartbeats = 0;
	let lists = 0;
	let reject = false;
	let clientAvailable = true;
	let now = 0;
	let leaseExpiresAt = LEASE_MS;
	let armed: number | null = null;
	const attempts = [
		{
			id: "attempt-1",
			workItemId: "work-1",
			heartbeatAt: "2026-09-19T21:59:00Z",
			runId: "run-1",
			executorType: "tedi",
			executorId: "cto",
			runtimeState: "running",
			finishedAt: null as string | null,
		},
	];
	const storage = {
		get: async (key: string) => rows.get(key),
		put: async (key: string, value: unknown) => {
			rows.set(key, value);
		},
		delete: async (key: string) => rows.delete(key),
	} as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">;
	const client = {
		listWorkAttempts: async () => {
			lists++;
			return { data: attempts, nextCursor: null };
		},
		heartbeatWorkAttempt: async (binding: { attemptId: string }) => {
			assert.equal(binding.attemptId, "attempt-1");
			assert.ok(
				rows.has("worklease:run-1"),
				"persist the fence before renewal",
			);
			if (reject || now >= leaseExpiresAt) throw new Error("STALE_ATTEMPT");
			heartbeats++;
			leaseExpiresAt = now + LEASE_MS;
			return attempts[0];
		},
	} as unknown as LeaseClient;
	const getClient = async () => (clientAvailable ? client : null);
	const deps: DelegatedWorkLeaseDeps = {
		storage,
		getClient,
		tediId: "cto",
		isSettled: () => settled,
		assertActive: async () => {
			if (canceled) throw new Error("canceled");
		},
		arm: async () => {
			armed = DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS;
		},
		now: () => now,
	};
	/** One alarm firing, on a fresh isolate, after the armed delay elapsed. */
	const tick = async () => {
		assert.notEqual(armed, null, "an alarm must be armed to fire");
		now += (armed ?? 0) * 1000;
		armed = null;
		return renewDelegatedWorkLease("run-1", {
			storage,
			getClient,
			validateWorkflow: observeWorkflow
				? (record) => validateDelegatedWorkLeaseWorkflow(record, { storage })
				: undefined,
			observeWorkflow,
			isSettled: () => settled,
			assertActive: async () => {
				if (rows.has("wfcancel:run-1")) throw new Error("canceled");
			},
			cancel: async () => {
				canceled = true;
				rows.set("wfcancel:run-1", true);
			},
			rearm: async (delaySeconds) => {
				armed = delaySeconds;
			},
			now: () => now,
		});
	};
	return {
		deps,
		rows,
		attempts,
		client,
		tick,
		get heartbeats() {
			return heartbeats;
		},
		get lists() {
			return lists;
		},
		get canceled() {
			return canceled;
		},
		get armed() {
			return armed;
		},
		get now() {
			return now;
		},
		get leaseExpiresAt() {
			return leaseExpiresAt;
		},
		set reject(value: boolean) {
			reject = value;
		},
		set settled(value: boolean) {
			settled = value;
		},
		set clientAvailable(value: boolean) {
			clientAvailable = value;
		},
		set now(value: number) {
			now = value;
		},
	};
}

// The core case: the turn goes quiet
// for TWICE the Attempt's lease window — no model steps, no tool callbacks, no
// progress events — and the invocation that holds the lease is LOST mid-wait,
// exactly as an evicted Durable Object loses it. Renewal is a durable alarm, so
// it carries the authority across the gap, and the workflow re-drive still
// answers instead of 409-ing on a dead Attempt.
{
	const f = fixture();
	// The lost invocation: it acquires the lease and then never runs again. Its
	// operation promise is deliberately left pending — there is no isolate.
	const abandoned = withDelegatedWorkLease(
		input,
		f.deps,
		() => new Promise<string>(() => {}),
	);
	// Let the entry heartbeat and the arm land, then walk away from it.
	await Promise.race([abandoned, Promise.resolve()]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(f.heartbeats, 1, "entry heartbeat");
	assert.equal(
		f.armed,
		DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS,
		"renewal is armed durably, not on a timer",
	);
	const quietUntil = 10 * 60_000;
	while (f.now < quietUntil) {
		const before = f.now;
		assert.equal(
			await f.tick(),
			true,
			"active renewal keeps the native interval",
		);
		assert.ok(f.now > before, "the alarm advances the clock");
		assert.ok(
			f.now < f.leaseExpiresAt,
			`authority lapsed at ${f.now}ms of quiet`,
		);
	}
	assert.ok(
		quietUntil > LEASE_MS,
		"the quiet period must exceed the lease window",
	);
	assert.equal(f.heartbeats, 1 + quietUntil / INTERVAL_MS);
	// The workflow re-drives the same run on a new isolate. Its entry heartbeat
	// is the one that used to 409 forever.
	assert.equal(
		await withDelegatedWorkLease(input, f.deps, async () => "quiet answer"),
		"quiet answer",
	);
	assert.equal(f.canceled, false, "a quiet turn keeps its authority");
	assert.equal(f.lists, 1, "reuse the retained attempt across the whole gap");
	assert.equal(f.rows.has(RENEWAL_KEY), false, "released once it answered");
}

// A released lease makes a stray alarm a no-op instead of a heartbeat on work
// nobody is doing.
{
	const f = fixture();
	assert.equal(
		await withDelegatedWorkLease(input, f.deps, async () => "done"),
		"done",
	);
	assert.equal(f.heartbeats, 1);
	f.rows.set(RENEWAL_KEY, {
		attemptId: "attempt-1",
		armedAt: 0,
		runId: "run-1",
		sessionKey: input.sessionKey,
		workItemId: "work-1",
	} satisfies DelegatedWorkLeaseRenewal);
	f.rows.delete(RENEWAL_KEY);
	await renewDelegatedWorkLease("run-1", {
		storage: f.deps.storage,
		getClient: f.deps.getClient,
		isSettled: () => assert.fail("a released lease reads nothing"),
		assertActive: async () => assert.fail("a released lease reads nothing"),
		cancel: async () => assert.fail("a released lease fences nothing"),
		rearm: async () => assert.fail("a released lease re-arms nothing"),
	});
	assert.equal(f.heartbeats, 1);
}

// A THROWN turn is a re-drive, not an ending. The `facet-turn` step retry backs
// off up to 240s against a 300s lease, so renewal must survive the gap.
{
	const f = fixture();
	await assert.rejects(
		withDelegatedWorkLease(input, f.deps, async () => {
			throw new Error("tool failed");
		}),
		/tool failed/,
	);
	assert.ok(
		f.rows.has(RENEWAL_KEY),
		"keep renewing across the workflow's retry backoff",
	);
	await f.tick();
	assert.equal(f.heartbeats, 2);
	assert.equal(f.canceled, false);
	// The retained binding is never rebound, even after a failed attempt.
	f.reject = true;
	f.attempts[0]!.id = "replacement";
	await assert.rejects(
		withDelegatedWorkLease(input, f.deps, async () =>
			assert.fail("stale execution must not start"),
		),
		/STALE_ATTEMPT/,
	);
	assert.deepEqual(
		f.rows.get("worklease:run-1"),
		{ workItemId: "work-1", attemptId: "attempt-1" },
		"never rebind to a replacement",
	);
	assert.equal(
		f.rows.has(RENEWAL_KEY),
		false,
		"stop renewing an Attempt that is gone",
	);
}

// Authority genuinely taken away still fences. An `expired` Attempt is the lease
// lapsing, not the run settling its own Work.
{
	const f = fixture();
	await withDelegatedWorkLease(input, f.deps, async () => "started");
	f.rows.set(RENEWAL_KEY, {
		attemptId: "attempt-1",
		armedAt: 0,
		runId: "run-1",
		sessionKey: input.sessionKey,
		workItemId: "work-1",
	} satisfies DelegatedWorkLeaseRenewal);
	f.attempts[0]!.runtimeState = "expired";
	f.attempts[0]!.finishedAt = "2026-09-17T22:26:56.000Z";
	f.reject = true;
	await f.tick();
	assert.equal(f.canceled, true, "lease loss must still fence the run");
	assert.equal(f.rows.has(RENEWAL_KEY), false);
	assert.equal(f.armed, null, "a fenced run stops renewing");
}

// Regression: the Attempt is settled at the run's second-to-last step, so it
// is terminal while the turn is still composing the reply that reports the
// outcome. The next
// renewal 409s. That MUST NOT be read as lease loss: writing the durable
// `wfcancel:<runId>` tombstone there denied the run's own final inference
// ("Chat inference denied for canceled or stopped run") and settled completed
// work with zero assistant output.
{
	const f = fixture();
	let finish!: () => void;
	const composing = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const running = withDelegatedWorkLease(input, f.deps, async () => {
		await composing;
		return "final answer";
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	// The settlement lands between two renewals.
	f.attempts[0]!.runtimeState = "failed";
	f.attempts[0]!.finishedAt = "2026-09-17T21:32:58.183Z";
	f.reject = true;
	await f.tick();
	assert.equal(f.canceled, false, "self-settlement must not fence the run");
	assert.equal(f.armed, null, "stop renewing a settled Attempt");
	assert.equal(f.rows.has(RENEWAL_KEY), false);
	finish();
	assert.equal(await running, "final answer");
}

// The same settlement seen by a workflow re-drive: the first renewal of the new
// invocation 409s on the already-terminal Attempt. The Work is done, so the
// re-drive must be allowed to produce the reply rather than fail the run.
{
	const f = fixture();
	f.rows.set("worklease:run-1", {
		workItemId: "work-1",
		attemptId: "attempt-1",
	});
	f.attempts[0]!.runtimeState = "finished";
	f.attempts[0]!.finishedAt = "2026-09-17T21:32:58.183Z";
	f.reject = true;
	assert.equal(
		await withDelegatedWorkLease(input, f.deps, async () => "redrive answer"),
		"redrive answer",
	);
	assert.equal(f.canceled, false);
	assert.equal(f.heartbeats, 0);
	assert.equal(f.armed, null, "a self-settled lease is never re-armed");
	assert.equal(f.rows.has(RENEWAL_KEY), false);
}

// Fail closed: an unreadable Attempt list is not proof of self-settlement.
{
	const f = fixture();
	await withDelegatedWorkLease(input, f.deps, async () => "started");
	f.rows.set(RENEWAL_KEY, {
		attemptId: "attempt-1",
		armedAt: 0,
		runId: "run-1",
		sessionKey: input.sessionKey,
		workItemId: "work-1",
	} satisfies DelegatedWorkLeaseRenewal);
	f.reject = true;
	f.client.listWorkAttempts = async () => {
		throw new Error("attempt list unavailable");
	};
	await f.tick();
	assert.equal(f.canceled, true);
}

// An unavailable platform client is not evidence about authority: re-arm rather
// than fence a turn over a transient binding failure.
{
	const f = fixture();
	await withDelegatedWorkLease(input, f.deps, async () => "started");
	f.rows.set(RENEWAL_KEY, {
		attemptId: "attempt-1",
		armedAt: 0,
		runId: "run-1",
		sessionKey: input.sessionKey,
		workItemId: "work-1",
	} satisfies DelegatedWorkLeaseRenewal);
	f.clientAvailable = false;
	await f.tick();
	assert.equal(f.canceled, false);
	assert.equal(f.armed, DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS);
	assert.ok(f.rows.has(RENEWAL_KEY));
}

// Every ordinary ending stops the alarm from inside the tick: a settled turn, a
// cancelled run, and the deadline backstop for a run whose dispatch vanished.
{
	for (const ending of ["settled", "canceled", "deadline"] as const) {
		const f = fixture();
		await withDelegatedWorkLease(input, f.deps, async () => "started");
		f.rows.set(RENEWAL_KEY, {
			attemptId: "attempt-1",
			armedAt: 0,
			runId: "run-1",
			sessionKey: input.sessionKey,
			workItemId: "work-1",
		} satisfies DelegatedWorkLeaseRenewal);
		if (ending === "settled") f.settled = true;
		if (ending === "canceled") {
			// A kernel cancel already wrote the fence; do not write a second one.
			f.rows.set("wfcancel:run-1", true);
		}
		if (ending === "deadline")
			f.now = DELEGATED_WORK_LEASE_RENEWAL_DEADLINE_MS - INTERVAL_MS;
		const before = f.heartbeats;
		assert.equal(
			await f.tick(),
			false,
			`${ending}: cancel the native interval`,
		);
		assert.equal(f.heartbeats, before, `${ending}: stop heartbeating`);
		assert.equal(f.armed, null, `${ending}: stop re-arming`);
		assert.equal(f.rows.has(RENEWAL_KEY), false, `${ending}: release`);
		assert.equal(f.canceled, false, `${ending}: no new fence`);
	}
}

// Entry is still the authority check: an expired Attempt must not execute, and a
// run with no Work Item is not leased at all.
{
	const f = fixture();
	f.now = LEASE_MS + 1;
	await assert.rejects(
		withDelegatedWorkLease(input, f.deps, async () =>
			assert.fail("expired execution must not start"),
		),
		/STALE_ATTEMPT/,
	);
	assert.equal(f.heartbeats, 0);
	assert.equal(f.armed, null, "never arm renewal for an Attempt that is gone");
	assert.equal(
		await withDelegatedWorkLease(
			{ runId: "direct", sessionKey: input.sessionKey },
			f.deps,
			async () => "direct",
		),
		"direct",
	);
}

// The binding lookup pages the Attempt list.
{
	const f = fixture();
	let page = 0;
	const matching = await f.client.listWorkAttempts({ workItemId: "work-1" });
	f.client.listWorkAttempts = async ({ cursor }) => {
		page++;
		if (!cursor) return { data: [], nextCursor: { at: "older", id: "cursor" } };
		assert.equal(cursor.id, "cursor");
		return matching;
	};
	await withDelegatedWorkLease(input, f.deps, async () => "found");
	assert.equal(page, 2);
}

// A produced waiting segment is not a final answer: renewal survives both the
// RPC return and quiet time beyond the lease's nominal five-minute lifetime.
{
	const f = fixture();
	const pending = {
		text: "",
		stopReason: "computer_pending",
		pendingComputerExecutions: ["exec-1"],
	};
	const deps = { ...f.deps, keepRenewal: hasPendingComputerExecutions };
	assert.deepEqual(
		await withDelegatedWorkLease(input, deps, async () => pending),
		pending,
	);
	const first = f.rows.get(RENEWAL_KEY) as DelegatedWorkLeaseRenewal;
	for (let i = 0; i < 7; i++) await f.tick();
	assert.ok(f.rows.has(RENEWAL_KEY));
	assert.equal(f.canceled, false);
	await withDelegatedWorkLease(
		input,
		{ ...deps, requireActiveAttempt: true },
		async () => pending,
	);
	assert.equal(
		(f.rows.get(RENEWAL_KEY) as DelegatedWorkLeaseRenewal).attemptId,
		first.attemptId,
	);
	assert.equal(
		(f.rows.get(RENEWAL_KEY) as DelegatedWorkLeaseRenewal).armedAt,
		first.armedAt,
	);
	await withDelegatedWorkLease(input, deps, async () => ({
		text: "done",
		stopReason: "stop",
	}));
	assert.equal(f.rows.has(RENEWAL_KEY), false);
}

// Native status/continuation cannot use the ordinary final-reply exception for
// a self-settled Attempt. It must never execute tools after any fence loss.
for (const state of ["failed", "finished", "expired", "cancelled"]) {
	const f = fixture();
	await withDelegatedWorkLease(
		input,
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	f.attempts[0]!.runtimeState = state;
	f.attempts[0]!.finishedAt = new Date().toISOString();
	f.reject = true;
	await assert.rejects(
		withDelegatedWorkLease(
			input,
			{ ...f.deps, requireActiveAttempt: true },
			async () => assert.fail("terminal fence must stop continuation"),
		),
		/STALE_ATTEMPT/,
	);
	assert.equal(f.rows.has(RENEWAL_KEY), false);
}

console.log("delegated-work-lease OK");

// A long native wait can outlive the bounded terminal watchdog, then die
// without its SDK callback. The recurring lease still observes its exact ID.
{
	let status = "running";
	let reads = 0;
	let redrive = false;
	let projectionFails = false;
	const f = fixture((record) =>
		observeDelegatedWorkLeaseWorkflow(record, {
			storage: f.deps.storage,
			reconcile: async (id) => {
				assert.equal(id, "native-1");
				reads++;
				if (status === "unreadable")
					throw new Error("native lookup unavailable");
				const decision = decideWorkflowTerminalReconciliation(status, {
					errorIsTransientReset: redrive,
					redrivesRemaining: true,
				});
				if (decision.action === "redrive") {
					status = "running";
					return false;
				}
				if (decision.action === "defer") return false;
				f.rows.set(delegatedWorkLeaseTerminalKey(input.runId), {
					workflowInstanceId: id,
				});
				if (projectionFails) throw new Error("assistant storage unavailable");
				return true;
			},
		}),
	);
	f.rows.set("wfctx:native-1", input);
	await withDelegatedWorkLease(
		{ ...input, workflowInstanceId: "native-1" },
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	for (let i = 0; i < WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS + 2; i++)
		assert.equal(await f.tick(), true);
	assert.ok(reads > WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS);
	for (const active of [
		"queued",
		"running",
		"waiting",
		"paused",
		"unknown",
		"unreadable",
	]) {
		status = active;
		assert.equal(await f.tick(), true);
	}
	status = "errored";
	redrive = true;
	assert.equal(
		await f.tick(),
		true,
		"permitted redrive keeps the original Attempt",
	);
	status = "errored";
	redrive = false;
	projectionFails = true;
	const before = f.heartbeats;
	assert.equal(
		await f.tick(),
		false,
		"terminal decision survives failed assistant persistence",
	);
	assert.equal(
		f.heartbeats,
		before + 1,
		"native reconciliation follows original Attempt heartbeat",
	);
	assert.equal(f.rows.has(RENEWAL_KEY), false);
	assert.equal(f.lists, 1, "native observation adds no Work list queries");
	await assert.rejects(
		withDelegatedWorkLease(
			{ ...input, workflowInstanceId: "native-1" },
			f.deps,
			async () => "replay",
		),
		/terminal/,
	);
}

for (const field of ["runId", "workItemId", "sessionKey"] as const) {
	let nativeCalls = 0;
	const f = fixture((record) =>
		observeDelegatedWorkLeaseWorkflow(record, {
			storage: f.deps.storage,
			reconcile: async () => {
				nativeCalls++;
				return false;
			},
		}),
	);
	await withDelegatedWorkLease(
		{ ...input, workflowInstanceId: "native-1" },
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	f.rows.set("wfctx:native-1", { ...input, [field]: "foreign" });
	const before = f.heartbeats;
	assert.equal(await f.tick(), false);
	assert.equal(nativeCalls, 0);
	assert.equal(f.heartbeats, before);
	assert.equal(f.canceled, true);
	assert.deepEqual(f.rows.get("worklease:run-1"), {
		workItemId: "work-1",
		attemptId: "attempt-1",
	});
}

for (const mapping of [undefined, "native-missing"]) {
	let nativeCalls = 0;
	const f = fixture((record) =>
		observeDelegatedWorkLeaseWorkflow(record, {
			storage: f.deps.storage,
			reconcile: async () => {
				nativeCalls++;
				return true;
			},
		}),
	);
	await withDelegatedWorkLease(
		{ ...input, workflowInstanceId: mapping },
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	assert.equal(
		await f.tick(),
		true,
		"missing legacy context is not a terminal outcome",
	);
	assert.equal(nativeCalls, 0);
}

{
	const f = fixture();
	await withDelegatedWorkLease(
		{ ...input, workflowInstanceId: "native-1" },
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	const before = f.heartbeats;
	await assert.rejects(
		withDelegatedWorkLease(
			{ ...input, workflowInstanceId: "foreign" },
			f.deps,
			async () => "replay",
		),
		/mapping changed/,
	);
	assert.equal(f.heartbeats, before);
	assert.equal(
		(f.rows.get(RENEWAL_KEY) as DelegatedWorkLeaseRenewal).workflowInstanceId,
		"native-1",
	);
}

// Terminal settlement can race an entry heartbeat or scheduler RPC. The final
// fence must win without replaying the operation or leaving renewed authority.
for (const boundary of ["heartbeat", "arm"] as const) {
	const f = fixture();
	let operations = 0;
	let unblock!: () => void;
	let reached!: () => void;
	const waiting = new Promise<void>((r) => {
		reached = r;
	});
	const pause = async () => {
		reached();
		await new Promise<void>((r) => {
			unblock = r;
		});
	};
	const client = {
		...f.client,
		heartbeatWorkAttempt: async (
			...args: Parameters<LeaseClient["heartbeatWorkAttempt"]>
		) => {
			const result = await f.client.heartbeatWorkAttempt(...args);
			if (boundary === "heartbeat") await pause();
			return result;
		},
	};
	const running = withDelegatedWorkLease(
		{ ...input, workflowInstanceId: "native-1" },
		{
			...f.deps,
			getClient: async () => client,
			arm: async () => {
				await f.deps.arm();
				if (boundary === "arm") await pause();
			},
		},
		async () => {
			operations++;
			return "should-not-run";
		},
	);
	await waiting;
	f.rows.set(delegatedWorkLeaseTerminalKey(input.runId), {
		workflowInstanceId: "native-1",
	});
	unblock();
	await assert.rejects(running, /terminal/);
	assert.equal(operations, 0);
	assert.equal(f.rows.has(RENEWAL_KEY), false);
}

{
	const pending = new Map<string, Promise<boolean>>();
	let restarts = 0;
	let finish!: (value: boolean) => void;
	const native = () => {
		restarts++;
		return new Promise<boolean>((r) => {
			finish = r;
		});
	};
	const watchdog = reconcileWorkflowOnce(pending, "native-1", native);
	const lease = reconcileWorkflowOnce(pending, "native-1", native);
	assert.equal(
		restarts,
		1,
		"overlapping observers cannot restart the same Workflow twice",
	);
	assert.equal(
		await reconcileWorkflowOnce(pending, "unrelated", async () => true),
		true,
	);
	finish(false);
	assert.deepEqual(await Promise.all([watchdog, lease]), [false, false]);
	assert.equal(pending.size, 0);
	await assert.rejects(
		reconcileWorkflowOnce(pending, "native-1", async () => {
			throw new Error("lookup");
		}),
		/lookup/,
	);
	assert.equal(pending.size, 0);
	assert.equal(
		await reconcileWorkflowOnce(pending, "native-1", async () => true),
		true,
	);
}

{
	let nativeCalls = 0;
	const f = fixture((record) =>
		observeDelegatedWorkLeaseWorkflow(record, {
			storage: f.deps.storage,
			reconcile: async () => {
				nativeCalls++;
				return true;
			},
		}),
	);
	f.rows.set("wfctx:native-1", input);
	await withDelegatedWorkLease(
		{ ...input, workflowInstanceId: "native-1" },
		{ ...f.deps, keepRenewal: () => true },
		async () => "pending",
	);
	f.reject = true;
	assert.equal(await f.tick(), false);
	assert.equal(
		nativeCalls,
		0,
		"expired original authority cannot reconcile or restart native work",
	);
	assert.equal(f.canceled, true);
}

function staleHeartbeat(
	overrides: { path?: string; status?: number; detail?: string } = {},
) {
	return new RpcCallError(
		overrides.path ?? "workItems/heartbeatAttempt",
		overrides.status ?? 409,
		overrides.detail ??
			JSON.stringify({
				json: {
					code: "CONFLICT",
					message:
						"STALE_ATTEMPT: Attempt attempt-1 is no longer authoritative",
				},
			}),
		"Conflict",
		undefined,
	);
}

async function lostAuthorityCase(options: {
	error?: Error;
	row?: Record<string, unknown> | null;
	readError?: boolean;
	requireActiveAttempt?: boolean;
	terminal?: boolean;
	finalReply?: boolean;
}) {
	const f = fixture();
	const bound = { workItemId: "work-1", attemptId: "attempt-1" };
	f.rows.set("worklease:run-1", bound);
	let reads = 0;
	let operations = 0;
	const error = options.error ?? staleHeartbeat();
	const row =
		options.row === null
			? null
			: {
					...f.attempts[0],
					runtimeState: "failed",
					finishedAt: "2026-09-19T22:00:00Z",
					...options.row,
				};
	const client: LeaseClient = {
		...f.client,
		heartbeatWorkAttempt: async () => {
			throw error;
		},
		listWorkAttempts: async () => {
			reads++;
			if (options.readError) throw new Error("read unavailable");
			return { data: row ? [row] : [], nextCursor: null } as unknown as Awaited<
				ReturnType<LeaseClient["listWorkAttempts"]>
			>;
		},
	};
	const run = withDelegatedWorkLease(
		input,
		{
			...f.deps,
			getClient: async () => client,
			requireActiveAttempt: options.requireActiveAttempt ?? true,
		},
		async () => {
			operations++;
			return "final reply";
		},
	);
	if (options.finalReply) {
		assert.equal(await run, "final reply");
		assert.equal(operations, 1);
	} else {
		await assert.rejects(
			run,
			options.terminal
				? /^Error: delegated_work_authority_lost: run=run-1 attempt=attempt-1 work=work-1$/
				: (actual: unknown) => actual === error,
		);
		assert.equal(operations, 0);
	}
	assert.equal(
		f.rows.get("worklease:run-1"),
		bound,
		"never replace the retained original Attempt",
	);
	assert.equal(f.rows.has(RENEWAL_KEY), false);
	assert.equal(
		f.canceled,
		false,
		"entry classification adds no cancellation tombstone",
	);
	return reads;
}

for (const runtimeState of ["finished", "failed", "expired", "cancelled"]) {
	assert.equal(
		await lostAuthorityCase({ row: { runtimeState }, terminal: true }),
		1,
	);
}
for (const runtimeState of ["finished", "failed"]) {
	assert.equal(
		await lostAuthorityCase({
			row: { runtimeState },
			requireActiveAttempt: false,
			finalReply: true,
		}),
		1,
	);
}

for (const error of [
	new Error("STALE_ATTEMPT"),
	new Error(staleHeartbeat().message), // local class identity cannot be reconstructed from text
	new Error("fetch failed"),
	new Error("request timed out"),
	staleHeartbeat({ status: 429 }),
	staleHeartbeat({ status: 503 }),
	staleHeartbeat({ path: "workItems/settleAttempt" }),
	staleHeartbeat({ detail: 'truncated {"json":' }),
	staleHeartbeat({ detail: "null" }),
	staleHeartbeat({
		detail: JSON.stringify({ code: "CONFLICT", message: "STALE_ATTEMPT" }),
	}),
	staleHeartbeat({
		detail: JSON.stringify({
			json: { code: "CONFLICT", message: "another conflict" },
		}),
	}),
	staleHeartbeat({
		detail: JSON.stringify({
			json: {
				code: "CONFLICT",
				message: "STALE_ATTEMPT: Attempt other is no longer authoritative",
			},
		}),
	}),
	staleHeartbeat({
		detail: JSON.stringify({
			json: {
				code: "BAD_REQUEST",
				message: "STALE_ATTEMPT: Attempt attempt-1 is no longer authoritative",
			},
		}),
	}),
]) {
	await lostAuthorityCase({ error });
}
for (const row of [
	null,
	{ id: "different-attempt" },
	{ workItemId: "different-work" },
	{ runId: "different-run" },
	{ executorType: "user" },
	{ executorId: "different-tedi" },
	{ finishedAt: null },
	{ finishedAt: "" },
	{ runtimeState: "running" },
	{ runtimeState: "waiting" },
]) {
	assert.equal(await lostAuthorityCase({ row }), 1);
}
assert.equal(await lostAuthorityCase({ readError: true }), 1);

// A newer concurrent heartbeat can win the CAS while the original Attempt is
// still active. The exact typed stale error must remain retryable, and the next
// entry must reuse the same binding rather than acquire replacement authority.
async function verifyConcurrentHeartbeatWinnerRetainsOriginalAuthority() {
	const f = fixture();
	const binding = { workItemId: "work-1", attemptId: "attempt-1" };
	f.rows.set("worklease:run-1", binding);
	const error = staleHeartbeat();
	let first = true;
	const client: LeaseClient = {
		...f.client,
		heartbeatWorkAttempt: async (bound) => {
			if (first) {
				first = false;
				f.attempts[0]!.heartbeatAt = "2026-09-19T22:00:01Z";
				throw error;
			}
			return f.client.heartbeatWorkAttempt(bound);
		},
	};
	const deps = {
		...f.deps,
		getClient: async () => client,
		requireActiveAttempt: true,
	};
	await assert.rejects(
		withDelegatedWorkLease(input, deps, async () =>
			assert.fail("CAS loser cannot execute"),
		),
		(actual) => actual === error,
	);
	assert.equal(
		await withDelegatedWorkLease(input, deps, async () => "recovered"),
		"recovered",
	);
	assert.equal(f.rows.get("worklease:run-1"), binding);
	assert.equal(f.canceled, false);
}

await verifyConcurrentHeartbeatWinnerRetainsOriginalAuthority();

// A fresh paginated read finds only the bound row, even behind a newer Attempt.
{
	const f = fixture();
	f.rows.set("worklease:run-1", {
		workItemId: "work-1",
		attemptId: "attempt-1",
	});
	const cursors: unknown[] = [];
	const client: LeaseClient = {
		...f.client,
		heartbeatWorkAttempt: async () => {
			throw staleHeartbeat();
		},
		listWorkAttempts: async ({ cursor }) => {
			cursors.push(cursor);
			return {
				data: [
					{
						...f.attempts[0],
						id: cursor ? "attempt-1" : "newer-attempt",
						runtimeState: "cancelled",
						finishedAt: "2026-09-19T22:00:00Z",
					},
				],
				nextCursor: cursor
					? null
					: { at: "2026-09-19T22:01:00Z", id: "newer-attempt" },
			} as unknown as Awaited<ReturnType<LeaseClient["listWorkAttempts"]>>;
		},
	};
	await assert.rejects(
		withDelegatedWorkLease(
			input,
			{ ...f.deps, getClient: async () => client, requireActiveAttempt: true },
			async () => assert.fail("terminal Attempt cannot execute"),
		),
		/delegated_work_authority_lost:/,
	);
	assert.equal(cursors.length, 2);
}
console.log(
	"confirmed Work authority loss: typed evidence, exact terminal rows, final reply and concurrent heartbeat recovery passed",
);

// An unavailable entry client is not evidence that the retained Attempt ended.
{
	const f = fixture();
	const binding = { workItemId: "work-1", attemptId: "attempt-1" };
	f.rows.set("worklease:run-1", binding);
	f.clientAvailable = false;
	await assert.rejects(
		withDelegatedWorkLease(
			input,
			{ ...f.deps, requireActiveAttempt: true },
			async () => assert.fail("no client cannot authorize execution"),
		),
		/^Error: Delegated Work lease client is unavailable$/,
	);
	assert.equal(f.rows.get("worklease:run-1"), binding);
	assert.equal(f.canceled, false);
}
