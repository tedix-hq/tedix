import assert from "node:assert/strict";
import {
	buildDurableCodemodeEvents,
	publishDurableCodemodeEvents,
} from "./durable-codemode-events";
import { RuntimeEventOutbox } from "./runtime-event-outbox";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
const context = {
	tediId: "t",
	runId: "r",
	conversationId: "c",
	homeRunId: "home",
	createdAt: "2026-09-21T00:00:00.000Z",
};
const result = {
	calls: [
		{
			seq: 0,
			state: "completed",
			connector: "native",
			method: "read",
			args: { path: "a" },
			result: "ok",
		},
		{ seq: 1, state: "error" },
		{ seq: 2, state: "pending" },
	],
};
const events = buildDurableCodemodeEvents(
	{ action: "approve", executionId: "e", status: "completed", result },
	context,
);
assert.deepEqual(
	events.map((e) => e.kind),
	[
		"tool.completed",
		"tool.completed",
		"tool.failed",
		"tool.started",
		"approval.resolved",
		"run.completed",
	],
);
assert.equal(events[1]?.id, "r:durable-code:e:call:0:completed");
assert.equal(events.at(-1)?.id, "r:durable-code:run-completed:e");
assert.ok(
	events.every(
		(e) =>
			e.createdAt === context.createdAt &&
			e.runId === "r" &&
			e.conversationId === "c",
	),
);
assert.equal(events.at(-2)?.payload?.homeRunId, "home");
assert.equal(events[0]?.payload?.result, result);
const rejected = buildDurableCodemodeEvents(
	{ action: "reject", executionId: "e", status: "rejected", result: {} },
	context,
);
assert.equal(rejected.at(-1)?.kind, "run.canceled");
assert.equal(
	buildDurableCodemodeEvents(
		{ action: "run", executionId: "e", status: "paused", result: {} },
		context,
	)[0]?.kind,
	"approval.requested",
);
assert.equal(
	buildDurableCodemodeEvents(
		{ action: "rollback", executionId: "e", status: "error", result: {} },
		context,
	).length,
	1,
);

// No client and transient API failures preserve every projected event, without
// asking the caller to repeat the already completed execution.
const rows = new Map<string, unknown>();
const storage = {
	put: async (k: string, v: unknown) => {
		rows.set(k, v);
	},
	get: async (k: string) => rows.get(k),
	delete: async (k: string) => rows.delete(k),
	list: async ({ prefix }: { prefix: string }) =>
		new Map([...rows].filter(([k]) => k.startsWith(prefix))),
};
let available = false;
const pending: Promise<unknown>[] = [];
const received: TediRuntimeEvent[] = [];
let failing = true;
const sink = {
	async recordRuntimeEvent(e: TediRuntimeEvent) {
		if (failing) throw Error("private provider details");
		received.push(e);
	},
};
const make = () =>
	new RuntimeEventOutbox({
		storage: storage as unknown as DurableObjectStorage,
		platform: async () => (available ? sink : null),
		waitUntil: (p) => {
			pending.push(p);
		},
		scheduleRedrive: async () => {},
	});
const outbox = make();
await publishDurableCodemodeEvents(outbox, events);
await Promise.all(pending);
assert.equal(rows.size, events.length);
available = true;
await make().redrive();
assert.equal(received.length, 0);
assert.equal(rows.size, events.length);
failing = false;
await make().redrive();
assert.equal(rows.size, 0);
assert.equal(received.at(-1)?.kind, "run.completed");
assert.deepEqual(
	received.map((e) => e.id).sort(),
	events.map((e) => e.id).sort(),
);
assert.ok(received.every((e) => e.createdAt === context.createdAt));

// A local persistence exception remains telemetry failure without exposing
// event identity, payload, or provider content in operational logs.
const secretEvents = events.map((event) => ({
	...event,
	id: "private-event-id",
	runId: "private-run-id",
	payload: { ...event.payload, private: "private-payload" },
}));
const logs: unknown[][] = [];
const original = console.error;
console.error = (...args: unknown[]) => {
	logs.push(args);
};
try {
	await publishDurableCodemodeEvents(
		{
			publish: async () => {
				throw new Error("private-provider-message", {
					cause: new TypeError("private-cause"),
				});
			},
			publishTerminal: async () => {
				throw new Error("private-provider-message", {
					cause: new TypeError("private-cause"),
				});
			},
		} as unknown as RuntimeEventOutbox,
		secretEvents,
	);
} finally {
	console.error = original;
}
assert.deepEqual(
	logs,
	secretEvents.map(() => [
		{
			component: "tedi-runtime-codemode",
			event: "tedi.durable_codemode_event_publish_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
		},
	]),
);
for (const secret of [
	"private-event-id",
	"private-run-id",
	"private-payload",
	"private-provider-message",
	"private-cause",
])
	assert.equal(JSON.stringify(logs).includes(secret), false);
console.log("durable-codemode-events.test.ts OK");
