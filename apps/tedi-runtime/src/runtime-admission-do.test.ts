import { Database } from "bun:sqlite";
import { RuntimeAdmission } from "./runtime-admission";
import assert from "node:assert/strict";
import {
	RuntimeAdmissionDO,
	assertStoredAgentToolDisposition,
	assertStoredTelegramDisposition,
	type AcceptedRuntimeTurn,
} from "./runtime-admission-do";

// Boundary unit proof; native SQL/recovery proof is in submissions.workerd.test.ts.
const inputHash = Array.from(
	new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				'{"input":{"text":"original"},"kind":"telegram"}',
			),
		),
	),
	(b) => b.toString(16).padStart(2, "0"),
).join("");
const original: AcceptedRuntimeTurn = {
	owner: { tediId: "tedi", orgId: "org", objectId: "object" },
	runId: "operation",
	sessionKey: "session",
	principalId: "service:telegram",
	inputHash,
	requestHash: "a".repeat(64),
	generation: 1,
};
let dispatchAssertions = 0;
const adapter = Object.create(
	RuntimeAdmissionDO.prototype,
) as RuntimeAdmissionDO;
adapter.lookupAcceptedTurn = async () => original;
Object.defineProperty(adapter, "gate", {
	value: {
		assertTurn() {
			dispatchAssertions++;
		},
	},
});
const exact = { kind: "telegram", input: { text: "original" } };
assert.equal(
	await adapter.assertOriginalClaim({ runId: "operation", input: exact }),
	original,
);
assert.equal(dispatchAssertions, 0);
assert.equal(
	await adapter.assertAcceptedTurn({ runId: "operation", input: exact }),
	original,
);
assert.equal(dispatchAssertions, 1);
for (const input of [
	{ kind: "telegram", input: { text: "recovered mutation" } },
	{ kind: "maintenance", input: { text: "original" } },
	{ ...exact, extra: true },
	undefined,
]) {
	await assert.rejects(
		adapter.assertOriginalClaim({ runId: "operation", input }),
	);
	await assert.rejects(
		adapter.assertAcceptedTurn({ runId: "operation", input }),
	);
}
assert.equal(
	dispatchAssertions,
	1,
	"changed inputs never reach dispatch authorization",
);
assert.equal(
	await adapter.assertOriginalClaim({ runId: "operation", inputHash }),
	original,
);
console.log("runtime admission immutable operation boundary passed");

const deliveredChild = {
	run_id: "original-child",
	status: "completed",
	completed_at: 1,
	child_still_running: 0,
	detached: 1,
	finish_delivered_at: 2,
	give_up_delivered_at: 1,
	output_json: "null",
	error_message: null,
};
assertStoredAgentToolDisposition(deliveredChild);
for (const change of [
	{ status: "interrupted" },
	{ child_still_running: 1 },
	{ finish_delivered_at: null },
	{ output_json: null },
	{ detached: undefined },
])
	assert.throws(
		() => assertStoredAgentToolDisposition({ ...deliveredChild, ...change }),
		/unknown external effect receipt/,
	);
const telegramInput = {
	turn: { operationId: "reply", sessionKey: "session" },
	thread: { id: "thread" },
};
const telegramHash = Array.from(
	new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(telegramInput)),
		),
	),
	(b) => b.toString(16).padStart(2, "0"),
).join("");
const reply = {
	version: 1,
	stage: "completed",
	...telegramInput,
	operation: {
		operationId: "reply",
		kind: "telegram",
		sessionKey: "session",
		requestHash: telegramHash,
		input: telegramInput,
	},
	claim: null,
	chunks: ["actual answer"],
	nextChunk: 1,
	messageIds: ["actual-message-id"],
};
await assertStoredTelegramDisposition("tedix:pi:telegram:reply:reply", reply);
for (const change of [
	{ stage: "uncertain" },
	{ messageIds: [] },
	{ nextChunk: 0 },
	{ error: "unknown send" },
])
	assert.throws(
		() =>
			assertStoredTelegramDisposition("tedix:pi:telegram:reply:reply", {
				...reply,
				...change,
			}),
		/unknown external effect receipt/,
	);
console.log("native effect disposition boundary passed");

const wireDb = new Database(":memory:");
let wireTransactionDepth = 0;
const wireStorage = {
	sql: {
		exec(q: string, ...v: unknown[]) {
			const rows = wireDb.query(q).all(...(v as never[]));
			return { toArray: () => rows };
		},
	},
	transactionSync<T>(fn: () => T): T {
		if (wireTransactionDepth) return fn();
		wireDb.run("BEGIN");
		wireTransactionDepth++;
		try {
			const result = fn();
			wireDb.run("COMMIT");
			return result;
		} catch (error) {
			wireDb.run("ROLLBACK");
			throw error;
		} finally {
			wireTransactionDepth--;
		}
	},
} as unknown as DurableObjectStorage;
const wireOwner = { tediId: "tedi", orgId: "org", objectId: "physical" };
new RuntimeAdmission(wireStorage, wireOwner, () => ({
	owner: wireOwner,
	digest: "a".repeat(64),
	complete: true,
	unknown: 0,
	nonterminal: 0,
})).initialize({
	operationId: "init",
	state: "active",
	evidence: "a".repeat(64),
});
const wireAdmission = new RuntimeAdmissionDO(wireStorage, wireOwner);
const admitted = (
	await wireAdmission.beginAcceptedTurn({
		runId: "observer",
		sessionKey: "session",
		principalId: "service:maintenance",
		input: { kind: "maintenance", nested: { text: "original" } },
		expectedGeneration: 1,
	})
).accepted;
assert.deepEqual(
	wireAdmission.assertAcceptedTurnSync({ runId: "observer" }),
	admitted,
);
assert.deepEqual(
	wireAdmission.assertAcceptedTurnSync({
		runId: "observer",
		expected: admitted,
	}),
	await wireAdmission.assertAcceptedTurn({ runId: "observer" }),
);
for (const field of [
	"sessionKey",
	"principalId",
	"inputHash",
	"requestHash",
	"generation",
] as const) {
	assert.throws(() =>
		wireAdmission.assertAcceptedTurnSync({
			runId: "observer",
			expected: {
				...admitted,
				[field]: field === "generation" ? 2 : "changed",
			},
		}),
	);
}
const saved = wireDb
	.query(
		"SELECT input FROM runtime_admission_identities WHERE run_id='observer'",
	)
	.all()[0] as { input: string };
wireDb.run(
	"UPDATE runtime_admission_identities SET input=? WHERE run_id='observer'",
	['{"kind":"maintenance","nested":{"text":"mutated"}}'],
);
assert.throws(
	() => wireAdmission.assertAcceptedTurnSync({ runId: "observer" }),
	/input hash mismatch/,
);
wireDb.run(
	"UPDATE runtime_admission_identities SET input=? WHERE run_id='observer'",
	[saved.input],
);
wireDb.run("DELETE FROM runtime_admission_turns WHERE id='observer'");
assert.throws(
	() => wireAdmission.assertAcceptedTurnSync({ runId: "observer" }),
	/dispatch denied/,
);
console.log("synchronous genuine observer claim boundary passed");
