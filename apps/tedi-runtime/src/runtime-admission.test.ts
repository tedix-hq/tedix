import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { RuntimeAdmission, type AdmissionEvidence } from "./runtime-admission";
const db = new Database(":memory:");
const storage = {
	sql: {
		exec(query: string, ...values: unknown[]) {
			const statement = db.query(query);
			const rows = statement.all(...(values as never[]));
			return { toArray: () => rows };
		},
	},
	transactionSync<T>(fn: () => T): T {
		db.run("BEGIN");
		try {
			const result = fn();
			db.run("COMMIT");
			return result;
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	},
} as unknown as DurableObjectStorage;
const owner = { tediId: "tedi", orgId: "org", objectId: "object" },
	digest = "a".repeat(64),
	requestHash = "b".repeat(64);
let unknown = 0;
const admission = new RuntimeAdmission(
	storage,
	owner,
	(action, input): AdmissionEvidence => ({
		owner,
		digest,
		complete: true,
		unknown,
		nonterminal: 0,
		...(action === "complete"
			? {
					terminal: true,
					claim: {
						turnId: input.turnId as string,
						requestHash: input.requestHash as string,
						generation: input.generation as number,
					},
				}
			: {}),
	}),
);
assert.equal(admission.read(), null);
assert.throws(
	() =>
		admission.beginTurn({ turnId: "turn", requestHash, expectedGeneration: 1 }),
	/unverified/,
);
unknown = 1;
assert.throws(
	() =>
		admission.initialize({
			operationId: "bad",
			state: "active",
			evidence: digest,
		}),
	/unverified/,
);
assert.equal(admission.read(), null);
unknown = 0;
const init = admission.initialize({
	operationId: "init",
	state: "active",
	evidence: digest,
});
assert.deepEqual(
	admission.initialize({
		operationId: "init",
		state: "active",
		evidence: digest,
	}),
	init,
);
assert.equal(
	admission.beginTurn({ turnId: "turn", requestHash, expectedGeneration: 1 })
		.newlyAccepted,
	true,
);
assert.equal(
	admission.beginTurn({ turnId: "turn", requestHash, expectedGeneration: 1 })
		.newlyAccepted,
	false,
);
assert.throws(
	() =>
		admission.hold({
			operationId: "hold",
			expectedGeneration: 1,
			evidence: digest,
		}),
	/unresolved/,
);
admission.quarantine({
	operationId: "quarantine",
	expectedGeneration: 1,
	reason: "unknown external effect",
});
assert.throws(
	() => admission.assertTurn({ turnId: "turn", requestHash, generation: 1 }),
	/denied/,
);
assert.throws(
	() =>
		admission.completeTurn({
			turnId: "missing",
			requestHash,
			generation: 1,
			evidence: digest,
		}),
	/unknown/,
);
const completed = admission.completeTurn({
	turnId: "turn",
	requestHash,
	generation: 1,
	evidence: digest,
});
assert.deepEqual(
	admission.completeTurn({
		turnId: "turn",
		requestHash,
		generation: 1,
		evidence: digest,
	}),
	completed,
);
assert.throws(
	() =>
		admission.completeTurn({
			turnId: "turn",
			requestHash,
			generation: 2,
			evidence: digest,
		}),
	/unknown/,
);
unknown = 1;
assert.throws(
	() =>
		admission.release({
			operationId: "release",
			expectedGeneration: 2,
			evidence: digest,
		}),
	/unverified/,
);
unknown = 0;
assert.equal(
	admission.release({
		operationId: "release",
		expectedGeneration: 2,
		evidence: digest,
	}).generation,
	3,
);
assert.throws(
	() => admission.assertTurn({ turnId: "turn", requestHash, generation: 1 }),
	/denied/,
);
admission.hold({
	operationId: "hold",
	expectedGeneration: 3,
	evidence: digest,
});
assert.equal(
	new RuntimeAdmission(storage, owner, () => {
		throw Error("no implicit verifier");
	}).read()?.state,
	"held",
);
admission.retire({
	operationId: "retire",
	expectedGeneration: 4,
	evidence: digest,
});
assert.throws(
	() =>
		admission.release({
			operationId: "reopen",
			expectedGeneration: 5,
			evidence: digest,
		}),
	/retired/,
);
console.log(
	"Durable admission CAS, exact turn identity, retained claims, late receipt reconciliation and no automatic reopen passed",
);
