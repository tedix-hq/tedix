import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	LEDGER_OUTBOX_PREFIX,
	type LedgerOutboxEntry,
	OBSERVATIONAL_MAX_REDRIVES,
	OBSERVATIONAL_PENDING_CAP,
	RuntimeEventOutbox,
	type RuntimeEventSink,
} from "./runtime-event-outbox";
import type { DerivedRuntimeEventSink } from "./k2-derived-events";

/** Minimal Map-backed stand-in for the DO storage surface the outbox touches. */
class FakeStorage {
	readonly rows = new Map<string, unknown>();
	async put<T>(key: string, value: T): Promise<void> {
		this.rows.set(key, value);
	}
	async get<T>(key: string): Promise<T | undefined> {
		return this.rows.get(key) as T | undefined;
	}
	async delete(key: string): Promise<boolean> {
		return this.rows.delete(key);
	}
	async list<T>(opts: { prefix: string }): Promise<Map<string, T>> {
		const out = new Map<string, T>();
		for (const [key, value] of this.rows) {
			if (key.startsWith(opts.prefix)) out.set(key, value as T);
		}
		return out;
	}
}

function event(
	runId: string,
	id: string,
	kind: TediRuntimeEvent["kind"] = "tool.completed",
): TediRuntimeEvent {
	return {
		id: `${runId}:${id}`,
		tediId: "tedi-1",
		kind,
		conversationId: "tedi-1:agent:main:main",
		runId,
		sequence: 1,
		payload: {},
		runtime: { backend: "cloudflare-agents" },
		createdAt: "2026-09-13T00:00:00.000Z",
	} as TediRuntimeEvent;
}

interface Harness {
	outbox: RuntimeEventOutbox;
	storage: FakeStorage;
	pending: Promise<unknown>[];
	recorded: TediRuntimeEvent[];
	redrives: number;
	settle(): Promise<void>;
}

function harness(
	sink: RuntimeEventSink | null,
	opts?: { fail?: boolean; derivedEvents?: DerivedRuntimeEventSink },
) {
	const storage = new FakeStorage();
	const pending: Promise<unknown>[] = [];
	const recorded: TediRuntimeEvent[] = [];
	const state = { redrives: 0 };
	const platform: RuntimeEventSink | null =
		sink ??
		(opts?.fail
			? {
					async recordRuntimeEvent() {
						throw new Error("ledger unreachable");
					},
				}
			: {
					async recordRuntimeEvent(e) {
						recorded.push(e);
						return null;
					},
				});
	const outbox = new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		waitUntil: (promise) => {
			pending.push(promise);
		},
		platform: async () => platform,
		derivedEvents: opts?.derivedEvents,
		scheduleRedrive: async () => {
			state.redrives++;
		},
	});
	return {
		outbox,
		storage,
		pending,
		recorded,
		get redrives() {
			return state.redrives;
		},
		async settle() {
			while (pending.length > 0) await Promise.allSettled(pending.splice(0));
		},
	} as Harness;
}

// 1. The hot path returns durable-but-unpublished: publish() resolves while the
//    remote write is still in flight. This is the whole point of the change — a
//    ~1s ledger RPC no longer sits between two model rounds.
{
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const recorded: TediRuntimeEvent[] = [];
	const h = harness({
		async recordRuntimeEvent(e) {
			await gate;
			recorded.push(e);
			return null;
		},
	});
	await h.outbox.publish(event("run-a", "tool.0.started"));
	assert.equal(recorded.length, 0, "remote write must not block publish()");
	assert.equal(h.storage.rows.size, 1, "event is durable locally first");
	const entry = ([...h.storage.rows] as [string, LedgerOutboxEntry][])[0];
	assert.ok(entry, "exactly one outbox row");
	assert.ok(entry[0].startsWith(`${LEDGER_OUTBOX_PREFIX}run-a:`));
	assert.equal(entry[1].class, "observational");

	release();
	await h.settle();
	assert.equal(recorded.length, 1, "background publish lands");
	assert.equal(h.storage.rows.size, 0, "and clears its outbox row");
}

// 2. A failed background publish keeps the row and arms the sweep; the sweep
//    then succeeds and clears it.
{
	let fail = true;
	const recorded: TediRuntimeEvent[] = [];
	const h = harness({
		async recordRuntimeEvent(e) {
			if (fail) throw new Error("ledger unreachable");
			recorded.push(e);
			return null;
		},
	});
	await h.outbox.publish(event("run-b", "step:1:0", "step.completed"));
	await h.settle();
	assert.equal(h.storage.rows.size, 1, "failed publish survives locally");
	assert.ok(h.redrives >= 1, "and arms the redrive sweep");

	fail = false;
	assert.equal(await h.outbox.redrive(), false, "sweep drains the outbox");
	assert.equal(recorded.length, 1);
	assert.equal(h.storage.rows.size, 0);
}

// Outbox diagnostics retain the exception cause and correlation without
// writing the event ID or an untrusted error message into Worker logs.
{
	const secret = "private-token-from-event-or-error";
	const failure = new Error(secret, { cause: new TypeError(secret) });
	const h = harness({
		async recordRuntimeEvent() {
			throw failure;
		},
	});
	const lines: string[] = [];
	const realWarn = console.warn;
	const realError = console.error;
	console.warn = (line: unknown) => lines.push(String(line));
	console.error = (line: unknown) => lines.push(String(line));
	try {
		await h.outbox.publish(event("opaque-run", secret));
		await h.settle();
		for (let i = 0; i < OBSERVATIONAL_MAX_REDRIVES; i++)
			await h.outbox.redrive();
	} finally {
		console.warn = realWarn;
		console.error = realError;
	}
	assert.ok(lines.length >= 2);
	assert.ok(!lines.some((line) => line.includes(secret)));
	const diagnostics = lines.map((line) => JSON.parse(line));
	const background = diagnostics.find(
		(line) => line._tr === "ledger_outbox_background_publish_failed",
	);
	assert.equal(background?.runId, "opaque-run");
	assert.equal(background?.kind, "tool.completed");
	assert.equal(background?.exception.type, "Error");
	assert.equal(background?.exception.cause?.type, "TypeError");
	assert.ok(
		diagnostics.some((line) => line._tr === "ledger_observational_exhausted"),
	);
	assert.equal(h.storage.rows.size, 1, "diagnostics do not discard evidence");
}

// A failed local put still attempts background delivery and reports the
// storage exception without leaking its message.
{
	const secret = "private-token-from-storage";
	const h = harness(null);
	const put = h.storage.put.bind(h.storage);
	h.storage.put = async <T>(key: string, value: T) => {
		if (key.startsWith(LEDGER_OUTBOX_PREFIX))
			throw new Error(secret, { cause: new TypeError(secret) });
		await put(key, value);
	};
	const lines: string[] = [];
	const realWarn = console.warn;
	console.warn = (line: unknown) => lines.push(String(line));
	try {
		await h.outbox.publish(event("storage-run", secret));
		await h.settle();
	} finally {
		console.warn = realWarn;
	}
	assert.equal(h.recorded.length, 1, "background delivery proceeds");
	assert.ok(!lines.some((line) => line.includes(secret)));
	const persist = lines
		.map((line) => JSON.parse(line))
		.find((line) => line._tr === "ledger_outbox_persist_failed");
	assert.equal(persist?.runId, "storage-run");
	assert.equal(persist?.delivery, "background_without_durability");
	assert.equal(persist?.exception.cause?.type, "TypeError");
}

// 3. Observational entries give up after their (short) budget with the
//    `ledger_observational_lost` marker, never the terminal one.
{
	const h = harness(null, { fail: true });
	const key = `${LEDGER_OUTBOX_PREFIX}run-c:tool.0.completed`;
	await h.storage.put<LedgerOutboxEntry>(key, {
		event: event("run-c", "tool.0.completed"),
		redrives: OBSERVATIONAL_MAX_REDRIVES - 1,
		firstDroppedAt: 0,
		class: "observational",
	});
	const errors: string[] = [];
	const realError = console.error;
	console.error = (line: unknown) => errors.push(String(line));
	try {
		assert.equal(await h.outbox.redrive(), true);
	} finally {
		console.error = realError;
	}
	assert.equal(h.storage.rows.size, 1, "exhausted entry remains recoverable");
	assert.ok(
		errors.some((line) => line.includes("ledger_observational_exhausted")),
		"reports exhausted observations",
	);
}

// 4. Legacy rows carry no `class`. They must keep the long TERMINAL budget —
//    a run.completed that vanished at redrive 6 would orphan the run.
{
	const h = harness(null, { fail: true });
	await h.storage.put<LedgerOutboxEntry>(`${LEDGER_OUTBOX_PREFIX}run-d:3`, {
		event: event("run-d", "3", "run.completed"),
		redrives: OBSERVATIONAL_MAX_REDRIVES,
		firstDroppedAt: 0,
	} satisfies LedgerOutboxEntry);
	assert.equal(await h.outbox.redrive(), true, "entries remain → reschedule");
	const row = (await h.storage.get(
		`${LEDGER_OUTBOX_PREFIX}run-d:3`,
	)) as LedgerOutboxEntry;
	assert.equal(row.redrives, OBSERVATIONAL_MAX_REDRIVES + 1);
}

// 5. flush(runId) is the visibility barrier: it awaits this isolate's in-flight
//    publishes and retries only that run's rows. Another run's backlog must not
//    be dragged into a settle.
{
	let fail = true;
	const recorded: TediRuntimeEvent[] = [];
	const h = harness({
		async recordRuntimeEvent(e) {
			if (fail) throw new Error("ledger unreachable");
			recorded.push(e);
			return null;
		},
	});
	await h.outbox.publish(event("run-e", "tool.0.completed"));
	await h.outbox.publish(event("run-f", "tool.0.completed"));
	await h.settle();
	assert.equal(h.storage.rows.size, 2);

	fail = false;
	await h.outbox.flush("run-e");
	assert.deepEqual(
		recorded.map((e) => e.runId),
		["run-e"],
		"flush is scoped to the run being settled",
	);
	assert.equal(h.storage.rows.size, 1);
}

// 6. flush() must not burn the terminal lane's retry budget or block a settle
//    behind it.
{
	const h = harness(null, { fail: true });
	await h.storage.put<LedgerOutboxEntry>(`${LEDGER_OUTBOX_PREFIX}run-g:3`, {
		event: event("run-g", "3", "run.completed"),
		redrives: 0,
		firstDroppedAt: 0,
		class: "terminal",
	});
	await h.outbox.flush("run-g");
	const row = (await h.storage.get(
		`${LEDGER_OUTBOX_PREFIX}run-g:3`,
	)) as LedgerOutboxEntry;
	assert.equal(row.redrives, 0, "flush leaves the terminal lane alone");
}

// 7. Saturation: past the cap the isolate stops growing DO storage but still
//    attempts the write, so a long API outage degrades rather than wedges.
{
	const h = harness(null, { fail: true });
	for (let i = 0; i <= OBSERVATIONAL_PENDING_CAP; i++) {
		await h.outbox.publish(event("run-h", `tool.${i}.completed`));
	}
	await h.settle();
	assert.equal(
		[...h.storage.rows.keys()].filter((key) =>
			key.startsWith(LEDGER_OUTBOX_PREFIX),
		).length,
		OBSERVATIONAL_PENDING_CAP,
		"persisted rows are capped",
	);
}

console.log("runtime-event-outbox.test.ts OK");

// A terminal cannot overtake selectively failing tool evidence. Cold redrive does
// not rely on insertion/key order; unrelated runs continue independently.
{
	let failing = true;
	const recorded: TediRuntimeEvent[] = [];
	const sink = {
		async recordRuntimeEvent(e: TediRuntimeEvent) {
			if (failing && e.kind === "tool.completed")
				throw new Error("tool unavailable");
			recorded.push(e);
			return null;
		},
	};
	const h = harness(sink);
	await h.outbox.publish(event("ordered", "z-tool"));
	await h.settle();
	assert.equal(await h.outbox.flush("ordered"), false);
	await h.outbox
		.orderedSink(sink)
		.recordRuntimeEvent(event("ordered", "a-terminal", "run.completed"));
	assert.equal(recorded.length, 0);
	await h.outbox.publishTerminal(
		event("unrelated", "terminal", "run.completed"),
	);
	assert.deepEqual(
		recorded.map((e) => e.runId),
		["unrelated"],
	);
	const cold = new RuntimeEventOutbox({
		storage: h.storage as unknown as DurableObjectStorage,
		platform: async () => sink,
		waitUntil: () => {},
		scheduleRedrive: async () => {},
	});
	await cold.redrive();
	assert.equal(recorded.length, 1);
	failing = false;
	await cold.redrive();
	assert.deepEqual(
		recorded.slice(1).map((e) => e.kind),
		["tool.completed", "run.completed"],
	);
	assert.equal(h.storage.rows.size, 0);
}

// Concurrent publish and terminal calls preserve invocation order even while the
// observational local put is pending. Concurrent sweeps cannot resurrect a row.
{
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness(null);
	const put = h.storage.put.bind(h.storage);
	h.storage.put = async (key, value) => {
		if (key.includes("tool")) await gate;
		await put(key, value);
	};
	const publication = h.outbox.publish(event("race", "tool"));
	const terminal = h.outbox.publishTerminal(
		event("race", "terminal", "run.completed"),
	);
	await Promise.resolve();
	assert.equal(h.recorded.length, 0);
	release();
	await Promise.all([publication, terminal]);
	await Promise.all([h.outbox.redrive(), h.outbox.redrive()]);
	assert.deepEqual(
		h.recorded.map((e) => e.kind),
		["tool.completed", "run.completed"],
	);
	assert.equal(h.storage.rows.size, 0);
}

// Exhaustion retains the original payload and terminal; recovery publishes both.
{
	let failing = true;
	const recorded: TediRuntimeEvent[] = [];
	const h = harness({
		async recordRuntimeEvent(e) {
			if (failing) throw Error("down");
			recorded.push(e);
			return null;
		},
	});
	await h.outbox.publish(event("exhausted", "tool"));
	await h.settle();
	await h.outbox.publishTerminal(
		event("exhausted", "terminal", "run.completed"),
	);
	for (let i = 0; i < OBSERVATIONAL_MAX_REDRIVES + 2; i++)
		await h.outbox.redrive();
	assert.equal(h.storage.rows.size, 2);
	assert.equal(recorded.length, 0);
	failing = false;
	await h.outbox.redrive();
	assert.deepEqual(
		recorded.map((e) => e.kind),
		["tool.completed", "run.completed"],
	);
}

// A broken delayed scheduler must not prevent an immediately deliverable
// terminal from closing the child after message.completed has landed.
{
	const storage = new FakeStorage();
	const recorded: TediRuntimeEvent[] = [];
	let scheduleCalls = 0;
	const outbox = new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		waitUntil: () => {},
		platform: async () => ({
			async recordRuntimeEvent(e) {
				recorded.push(e);
			},
		}),
		scheduleRedrive: async () => {
			scheduleCalls++;
			throw new Error("scheduler unavailable");
		},
	});
	await outbox.publishTerminal(event("scheduler", "3", "run.completed"));
	assert.deepEqual(
		recorded.map((e) => e.kind),
		["run.completed"],
	);
	assert.equal(scheduleCalls, 0, "successful send needs no delayed scheduler");
	assert.equal(storage.rows.size, 0);
}

// An already-failed observational row remains a barrier, but terminal
// publication must not synchronously retry every row a second time.
{
	const h = harness(null);
	let observationAttempts = 0;
	const sink = {
		async recordRuntimeEvent(e: TediRuntimeEvent) {
			if (e.kind === "tool.completed") {
				observationAttempts++;
				throw new Error("observation unavailable");
			}
			h.recorded.push(e);
		},
	};
	const outbox = new RuntimeEventOutbox({
		storage: h.storage as unknown as DurableObjectStorage,
		waitUntil: (promise) => h.pending.push(promise),
		platform: async () => sink,
		scheduleRedrive: async () => {},
	});
	await outbox.publish(event("blocked-terminal", "tool"));
	await h.settle();
	assert.equal(observationAttempts, 1);
	await outbox.publishTerminal(event("blocked-terminal", "3", "run.completed"));
	assert.equal(observationAttempts, 1, "terminal does not retry a failed row");
	assert.equal(h.recorded.length, 0, "terminal stays fenced behind evidence");
	assert.equal(h.storage.rows.size, 2, "both rows survive for redrive");
}

// Saturated evidence loss is explicit and durable across a cold outbox. It must
// never be mistaken for an empty successfully-drained queue.
{
	const h = harness(null, { fail: true });
	for (let i = 0; i < OBSERVATIONAL_PENDING_CAP; i++)
		await h.storage.put(`${LEDGER_OUTBOX_PREFIX}cap:${i}`, {
			event: event("cap", String(i)),
			redrives: 0,
			firstDroppedAt: 0,
			class: "observational",
		} satisfies LedgerOutboxEntry);
	await h.outbox.publish(event("overflow", "lost"));
	await h.settle();
	assert.equal(await h.outbox.flush("overflow"), false);
	const recorded: TediRuntimeEvent[] = [];
	const cold = new RuntimeEventOutbox({
		storage: h.storage as unknown as DurableObjectStorage,
		platform: async () => ({
			async recordRuntimeEvent(e) {
				recorded.push(e);
			},
		}),
		waitUntil: () => {},
		scheduleRedrive: async () => {},
	});
	await cold.publishTerminal(event("overflow", "terminal", "run.completed"));
	assert.equal(recorded.length, 0);
	assert.equal(await cold.flush("overflow"), false);
}

// IDs need not embed runId: actual event identity is authoritative for the barrier.
{
	const h = harness(null, { fail: true });
	await h.outbox.publish({
		...event("identity", "tool"),
		id: "opaque-provider-id",
	});
	await h.settle();
	assert.equal(await h.outbox.flush("identity"), false);
	await h.outbox.publishTerminal(
		event("identity", "terminal", "run.completed"),
	);
	assert.equal(h.storage.rows.size, 2);
}

// Cap reservation is global across runs. An unresolved background-only send has
// its durable barrier before eviction, and only its own confirmed success clears it.
{
	const rows = new Map<string, unknown>();
	for (let i = 0; i < OBSERVATIONAL_PENDING_CAP - 1; i++)
		rows.set(`${LEDGER_OUTBOX_PREFIX}seed:${i}`, {
			event: event("seed", String(i)),
			redrives: 0,
			firstDroppedAt: 0,
			class: "observational",
		});
	const storage = new FakeStorage();
	for (const [key, value] of rows) await storage.put(key, value);
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const sink = {
		async recordRuntimeEvent() {
			await wait;
		},
	};
	const pending: Promise<unknown>[] = [];
	const original = new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		platform: async () => sink,
		waitUntil: (p) => {
			pending.push(p);
		},
		scheduleRedrive: async () => {},
	});
	await Promise.all([
		original.publish(event("first", "tool")),
		original.publish(event("second", "tool")),
	]);
	assert.equal(
		[...storage.rows.keys()].filter((k) => k.startsWith(LEDGER_OUTBOX_PREFIX))
			.length,
		OBSERVATIONAL_PENDING_CAP,
	);
	const confirmed: TediRuntimeEvent[] = [];
	const cold = new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		platform: async () => ({
			async recordRuntimeEvent(e) {
				confirmed.push(e);
			},
		}),
		waitUntil: () => {},
		scheduleRedrive: async () => {},
	});
	assert.equal(
		await cold.flush("second"),
		false,
		"cold barrier sees unresolved non-durable send",
	);
	await cold.publishTerminal(event("second", "terminal", "run.completed"));
	assert.equal(confirmed.length, 0);
	release();
	await Promise.all(pending);
	assert.equal(
		await cold.flush("second"),
		true,
		"only confirmed delivery clears the marker",
	);
}

// A failed hydration does not permanently poison the instance or admit payloads
// against an unknown queue size. Later publication retries the storage read.
{
	const h = harness(null);
	const list = h.storage.list.bind(h.storage);
	let count = 0;
	h.storage.list = async (opts) => {
		if (++count === 1) throw Error("storage temporarily unavailable");
		return list(opts);
	};
	await h.outbox.publish(event("hydrate", "one"));
	await h.settle();
	await h.outbox.publish(event("hydrate", "two"));
	await h.settle();
	assert.ok(count >= 2);
	assert.equal(await h.outbox.flush("hydrate"), true);
}

// Operator diagnostics read one exact run without publishing or exposing payloads.
{
	const h = harness(null, { fail: true });
	await h.outbox.publish(event("inspect", "tool"));
	await h.outbox.publish(event("inspect-other", "tool"));
	await h.settle();
	await h.outbox.publishTerminal(event("inspect", "3", "run.completed"));
	const snapshot = await h.outbox.inspectRun("inspect");
	assert.equal(snapshot.observational, 1);
	assert.equal(snapshot.terminal, 1);
	assert.deepEqual(snapshot.kinds, {
		"tool.completed": 1,
		"run.completed": 1,
	});
	assert.equal(snapshot.blockedPending, 0);
	assert.equal(snapshot.inFlight, 0);
	assert.ok(snapshot.oldestPendingAgeMs !== null);
	assert.equal(
		JSON.stringify(snapshot).includes("inspect-other"),
		false,
		"other runs and event payloads stay out of the response",
	);
	assert.equal(h.storage.rows.size, 3, "inspection does not mutate the queue");
}

// The same snapshot distinguishes an in-flight observation and a durable
// non-durable-send marker without waiting for or changing either one.
{
	const storage = new FakeStorage();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending: Promise<unknown>[] = [];
	const outbox = new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		waitUntil: (promise) => pending.push(promise),
		platform: async () => ({
			async recordRuntimeEvent() {
				await gate;
			},
		}),
		scheduleRedrive: async () => {},
	});
	await outbox.publish(event("in-flight", "tool"));
	await storage.put("ledger-delivery-blocked:in-flight", { pending: 2 });
	const snapshot = await outbox.inspectRun("in-flight");
	assert.equal(snapshot.inFlight, 1);
	assert.equal(snapshot.blockedPending, 2);
	assert.equal(snapshot.observational, 1);
	release();
	await Promise.allSettled(pending);
}

// K2 fan-out starts only after the canonical API/D1 write resolves. It is a
// derivative lane: failure is reported but cannot retain or block ledger rows.
{
	let releaseCanonical!: () => void;
	const canonicalGate = new Promise<void>((resolve) => {
		releaseCanonical = resolve;
	});
	const order: string[] = [];
	const h = harness(
		{
			async recordRuntimeEvent() {
				await canonicalGate;
				order.push("canonical");
			},
		},
		{
			derivedEvents: {
				async publish() {
					order.push("derived");
				},
			},
		},
	);
	await h.outbox.publish(event("derived-order", "tool"));
	assert.deepEqual(order, []);
	releaseCanonical();
	await h.settle();
	assert.deepEqual(order, ["canonical", "derived"]);
	assert.equal(h.storage.rows.size, 0);
}

{
	const warnings: string[] = [];
	const realWarn = console.warn;
	console.warn = (line: unknown) => warnings.push(String(line));
	try {
		const h = harness(null, {
			derivedEvents: {
				async publish() {
					throw new Error("K2 unavailable");
				},
			},
		});
		await h.outbox.publish(event("derived-failure", "tool"));
		await h.settle();
		assert.equal(h.storage.rows.size, 0, "K2 never gates canonical cleanup");
		assert.ok(
			warnings.some((line) => line.includes("k2_derived_event_publish_failed")),
		);
	} finally {
		console.warn = realWarn;
	}
}
