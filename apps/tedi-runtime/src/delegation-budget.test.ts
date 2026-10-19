import assert from "node:assert/strict";
import {
	DelegationBudgetGate,
	delegationBudgetForMetadata,
	runWithDelegationDeadline,
} from "./delegation-budget";

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
let now = 1000;
const gate = new DelegationBudgetGate(storage, () => now);
const budget = delegationBudgetForMetadata(
	{ delegationWorkOrder: { budget: { maxToolCalls: 8, deadlineMs: 300000 } } },
	now,
)!;
assert.deepEqual(budget, { maxToolCalls: 8, deadlineAt: 301000 });
assert.throws(() =>
	delegationBudgetForMetadata({ delegationBudget: { maxToolCalls: -1 } }, now),
);
await gate.enroll("bounded-replay", budget);
const results = await Promise.all(
	Array.from({ length: 12 }, (_, i) =>
		gate.claim("bounded-replay", `call-${i}`),
	),
);
assert.equal(
	results.filter((reason) => reason === null).length,
	8,
	"parallel calls cannot overspend",
);
const restarted = new DelegationBudgetGate(storage, () => now);
await restarted.enroll("bounded-replay", { ...budget, deadlineAt: 900000 });
assert.equal(
	(await restarted.inspect("bounded-replay"))?.deadlineAt,
	301000,
	"retry cannot extend deadline",
);
assert.match((await restarted.claim("bounded-replay", "ninth"))!, /8\/8/);
await assert.rejects(
	restarted.enroll("bounded-replay", { maxToolCalls: 20 }),
	/changed/,
);
await gate.enroll("timed-replay", budget);
now = 301000;
assert.match((await restarted.claim("timed-replay", "late"))!, /deadline/);
assert.match((await restarted.stopReason("timed-replay"))!, /deadline/);
assert.equal(await gate.stopReason("ordinary-turn"), null);
console.log(
	"PASS bounded delegation replay: eight calls, immutable deadline, restart and parallel fences",
);
let upstream: AbortSignal | undefined;
await assert.rejects(
	runWithDelegationDeadline(Date.now() + 15, async (signal) => {
		upstream = signal;
		return new Promise(() => {});
	}),
	/deadline reached/,
);
assert.equal(upstream?.aborted, true);
let dispatches = 0;
await assert.rejects(
	runWithDelegationDeadline(Date.now() - 1, async () => {
		dispatches++;
	}),
	/deadline reached/,
);
assert.equal(dispatches, 0);
