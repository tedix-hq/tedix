import assert from "node:assert/strict";
import { FacetDispatchJournal } from "./facet-dispatch-journal";
import { PiTurnAccounting } from "./pi-turn-accounting";

const rows = new Map<string, unknown>();
let queue = Promise.resolve();
const storage = {
	get: async (key: string) => structuredClone(rows.get(key)),
	put: async (key: string, value: unknown) => {
		rows.set(key, structuredClone(value));
	},
	transaction: <T>(fn: (tx: typeof storage) => Promise<T>): Promise<T> => {
		const next = queue.then(() => fn(storage));
		queue = next.then(
			() => {},
			() => {},
		);
		return next;
	},
} as unknown as Pick<DurableObjectStorage, "get" | "put" | "transaction">;
const journal = new FacetDispatchJournal(storage);
const call = {
	runId: "run",
	toolCallId: "call",
	tool: "exec",
	args: { command: "write" },
};
assert.equal(await journal.claim(call, false), false);
assert.equal(
	await journal.rejected("run", "call", async () => false),
	null,
	"untracked is not proven rejected",
);
await journal.enroll("run");
assert.equal(await journal.claim(call, false), false);
assert.deepEqual(await journal.rejected("run", "call", async () => false), {
	rejectedBeforeDispatch: true,
	terminal: true,
	tool: "exec",
});
assert.equal(
	await new FacetDispatchJournal(storage).claim(call, true),
	false,
	"rebind never replays rejected identity",
);
assert.equal(await journal.rejected("other", "call", async () => false), null);
assert.equal(await journal.rejected("run", "other", async () => false), null);
await assert.rejects(
	journal.claim({ ...call, tool: "write" }, true),
	/identity/,
);
await assert.rejects(
	journal.claim({ ...call, args: { command: "other" } }, true),
	/identity/,
);

const dispatched = { ...call, toolCallId: "dispatched" };
assert.equal(await journal.claim(dispatched, true), true);
await journal.enroll("run");
assert.equal(await journal.claim(dispatched, false), false);
assert.equal(
	await journal.rejected("run", "dispatched", async () => false),
	null,
	"late rejection cannot erase dispatch intent",
);
assert.equal(
	await new FacetDispatchJournal(storage).claim(dispatched, true),
	false,
	"reset after dispatch intent cannot repeat it",
);
assert.equal(await journal.returned("run", "dispatched"), null);
await assert.rejects(
	journal.markReturned(
		{ ...dispatched, args: { command: "other" } },
		"facet-tool-proxy",
	),
	/identity|receipt/,
);
await journal.markReturned(dispatched, "facet-tool-proxy");
await journal.markReturned(dispatched, "facet-tool-proxy");
assert.deepEqual(
	await new FacetDispatchJournal(storage).returned("run", "dispatched"),
	{
		kind: "facet_tool_returned",
		terminal: true,
		tool: "exec",
		finishReason: "facet-tool-proxy",
		resultLost: true,
	},
);
await assert.rejects(
	journal.markReturned(dispatched, "facet-tool-error"),
	/Conflicting facet terminal receipt/,
);
await assert.rejects(
	journal.markReturned(call, "facet-tool-proxy"),
	/Missing or conflicting facet dispatch receipt/,
);
assert.equal(await journal.returned("other", "dispatched"), null);
const race = { ...call, toolCallId: "race" };
const permits = await Promise.all([
	journal.claim(race, true),
	journal.claim(race, false),
	journal.claim(race, true),
]);
assert.ok(permits.filter(Boolean).length <= 1);
if (permits.some(Boolean))
	assert.equal(await journal.rejected("run", "race", async () => false), null);

const authority = {
	assertActive: async () => {},
	reserveStep: async () => {},
	recordStep: async () => {},
	reconcileEffect: async (runId: string, id: string) =>
		(await journal.returned(runId, id)) ??
		(await journal.rejected(runId, id, async () => false)),
};
const accounting = new PiTurnAccounting(storage, authority);
const context = { messages: [{ role: "user" as const, content: "work" }] };
await accounting.enrollDispatch("A", () => journal.enroll("A"));
await accounting.begin("A");
await accounting.prepareStep(context, { maxSteps: 4 });
await accounting.beforeToolCall("rejected", "exec");
await journal.claim({ ...call, runId: "A", toolCallId: "rejected" }, false);
let enrolledAgain = false;
await accounting.enrollDispatch("B", () => journal.enroll("B"));
await accounting.enrollDispatch("A", async () => {
	enrolledAgain = true;
});
assert.equal(enrolledAgain, false, "A -> B -> A is not a fresh enrollment");
const restarted = new PiTurnAccounting(storage, authority);
assert.equal((await restarted.reconcileEffects("A")).length, 1);
await restarted.begin("A");
await restarted.prepareStep(context, { maxSteps: 4 });
assert.equal((await restarted.inspect("A")).attempts[0]?.phase, "unknown");
assert.equal(
	(await restarted.usage()).totalTokens,
	null,
	"rejection is not a provider usage receipt",
);
await restarted.beforeToolCall("rejected2", "exec");
await restarted.beforeToolCall("uncertain", "exec");
await journal.claim({ ...call, runId: "A", toolCallId: "rejected2" }, false);
assert.deepEqual(await restarted.reconcileEffects("A"), []);
assert.equal(
	(await restarted.inspect("A")).attempts[1]?.effectsSealed,
	undefined,
);
const unknownRestart = new PiTurnAccounting(storage, authority);
await unknownRestart.begin("A");
await assert.rejects(
	unknownRestart.prepareStep(context, { maxSteps: 4 }),
	/Interrupted tool effects/,
);
console.log("Facet dispatch journal and exact-effect recovery tests passed.");

let freshEnrolled = false;
await unknownRestart.enrollDispatch("fresh-after-fault", async () => {
	freshEnrolled = true;
});
assert.equal(
	freshEnrolled,
	true,
	"another run's in-memory fault cannot poison fresh enrollment",
);
const failedEmpty = new PiTurnAccounting(storage, authority);
await failedEmpty.begin("empty-fault");
await assert.rejects(
	failedEmpty.block(new Error("durable fault")),
	/durable fault/,
);
await assert.rejects(
	failedEmpty.enrollDispatch("empty-fault", async () => {}),
	/durable fault/,
);

await assert.rejects(
	journal.rejected("run", "call", async () => true),
	/Conflicting facet execution/,
	"retained dispatch intent conflicts even when process status is unknown",
);

const returnedAccounting = new PiTurnAccounting(storage, authority);
await returnedAccounting.enrollDispatch("returned-run", () =>
	journal.enroll("returned-run"),
);
await returnedAccounting.begin("returned-run");
await returnedAccounting.prepareStep(context, { maxSteps: 4 });
await returnedAccounting.beforeToolCall("returned-call", "exec");
const returnedCall = {
	...call,
	runId: "returned-run",
	toolCallId: "returned-call",
};
assert.equal(await journal.claim(returnedCall, true), true);
assert.deepEqual(
	await new PiTurnAccounting(storage, authority).reconcileEffects(
		"returned-run",
	),
	[],
	"dispatch intent without a terminal marker cannot clear the effect fence",
);
await journal.markReturned(returnedCall, "facet-tool-error");
const recovered = new PiTurnAccounting(storage, authority);
const recoveredEffects = await recovered.reconcileEffects("returned-run");
assert.deepEqual(recoveredEffects, [
	{
		kind: "facet_tool_returned",
		terminal: true,
		tool: "exec",
		finishReason: "facet-tool-error",
		resultLost: true,
		toolCallId: "returned-call",
	},
]);
assert.equal(
	(await recovered.inspect("returned-run")).attempts[0]?.effectsSealed,
	true,
);
