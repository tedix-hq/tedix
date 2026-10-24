import assert from "node:assert/strict";
import type { HarnessInspection } from "@earendil-works/pi-durable";
import { PiAgent } from "./pi-agent";
import {
	inspectExistingPiFacet,
	projectPiRecovery,
} from "./pi-recovery-diagnostic";
const inspection = {
	scheduling: "paused",
	tasks: Array.from({ length: 60 }, (_, index) => ({
		record: {
			id: index + 1,
			conversationId: 1,
			kind: "fixture.task",
			owner: undefined,
			background: false,
			abortRequested: false,
			input: "PRIVATE_INPUT",
			memos: { secret: "PRIVATE_MEMO" },
			state: { status: "pending", checkpoint: "PRIVATE_CHECKPOINT" },
		},
		state:
			index === 0
				? { kind: "blocked", reason: "missing_task", error: "PRIVATE_ERROR" }
				: {
						kind: "waiting",
						on: Array.from({ length: 25 }, (_, id) => id + 1),
					},
	})),
	submissions: [
		{
			id: 1,
			conversationId: 1,
			requestId: "operation",
			type: "input",
			status: "placed",
			entry: 1,
			content: "PRIVATE_CONTENT",
		},
	],
} as unknown as HarnessInspection;
const projected = projectPiRecovery({
	sessionKey: "session",
	conversationId: 1,
	inspection,
});
assert.equal(projected.tasks.length, 50);
assert.equal(projected.taskCount, 60);
assert.equal(projected.truncated, true);
assert.equal(projected.tasks[0]?.blockedReason, "missing_task");
assert.equal(projected.tasks[1]?.waitingOn.length, 20);
assert.equal(projected.tasks[1]?.waitingOnTruncated, true);
assert.equal(projected.tasks[0]?.restarts, undefined);
assert.equal(projected.tasks[0]?.sleepUntil, undefined);
assert.ok(!JSON.stringify(projected).includes("PRIVATE_"));
assert.equal(
	projectPiRecovery({ sessionKey: "session", conversationId: 2, inspection })
		.taskCount,
	0,
);
// Pi 1.4's sleeping and restart-limited tasks remain visible without leaking checkpoints.
for (const state of [
	{ kind: "sleeping", until: 1234 },
	{ kind: "blocked", reason: "restart_limit" },
] as const) {
	const view = projectPiRecovery({
		sessionKey: "session",
		conversationId: 1,
		inspection: {
			...inspection,
			tasks: [
				{
					...inspection.tasks[0]!,
					record: {
						...inspection.tasks[0]!.record,
						restarts: 5,
						state: {
							status: "sleeping",
							until: 1234,
							checkpoint: "PRIVATE_CHECKPOINT",
						},
					},
					state,
				},
			],
		},
	});
	assert.equal(view.tasks[0]?.status, "sleeping");
	assert.equal(view.tasks[0]?.view, state.kind);
	assert.equal(view.tasks[0]?.restarts, 5);
	assert.equal(
		view.tasks[0]?.sleepUntil,
		state.kind === "sleeping" ? 1234 : undefined,
	);
	assert.equal(
		view.tasks[0]?.blockedReason,
		state.kind === "blocked" ? "restart_limit" : null,
	);
	assert.ok(!JSON.stringify(view).includes("PRIVATE_"));
}
for (const invalid of [-1, Infinity, NaN, Number.MAX_VALUE]) {
	const result = projectPiRecovery({
		sessionKey: "session",
		conversationId: 1,
		inspection: {
			...inspection,
			tasks: [
				{
					...inspection.tasks[0]!,
					record: { ...inspection.tasks[0]!.record, restarts: invalid },
					state: { kind: "sleeping", until: invalid },
				},
			],
		},
	});
	assert.equal(result.tasks[0]?.sleepUntil, undefined);
	assert.equal(result.tasks[0]?.restarts, undefined);
}
let gets = 0;
await assert.rejects(
	inspectExistingPiFacet({
		sessionKey: "missing",
		has: () => false,
		get: async () => {
			gets++;
			throw Error("Should not create");
		},
	}),
	/session_unavailable/,
);
assert.equal(gets, 0);
await assert.rejects(
	inspectExistingPiFacet({
		sessionKey: " session",
		has: () => true,
		get: async () => {
			gets++;
			throw Error("Should not create");
		},
	}),
);
assert.equal(gets, 0);
const probe = Object.create(PiAgent.prototype);
assert.equal(
	probe._isCallable("inspectRecovery"),
	false,
	"diagnostic RPC is not exposed as a browser callable",
);
Object.defineProperty(probe, "state", {
	value: { sessionKey: "exact:session" },
});
probe.ctx = { storage: { get: async () => undefined } };
probe.piHarness = {
	pi: async () => {
		throw new Error("Must not open native harness");
	},
};
await assert.rejects(
	probe.inspectRecovery("exact/session"),
	/session_mismatch/,
);
await assert.rejects(
	probe.inspectRecovery("exact:session", "missing-operation"),
	/operation_unavailable/,
);
console.log(
	"Native Pi recovery projection: bounded metadata, no payloads, exact ownership and read-only lookup pass",
);
// An owned operation uses only native lookup and inspection, never a turn API.
{
	const calls: string[] = [];
	const operation = {
		id: 1,
		conversationId: 1,
		requestId: "owned",
		type: "input",
		status: "done",
		entry: 1,
		answer: 2,
		detail: "PRIVATE_RECEIPT",
	};
	probe.ctx = {
		storage: {
			get: async (key: string) =>
				key === "pi-operation-conversation:owned" ? 1 : undefined,
		},
	};
	probe.piHarness = {
		pi: async () => ({
			conversation: async () => {
				calls.push("conversation");
				return { id: 1 };
			},
			inspect: async () => {
				calls.push("inspect");
				return { scheduling: "paused", tasks: [], submissions: [] };
			},
		}),
		storage: async () => ({
			submissionByRequest: async () => {
				calls.push("receipt");
				return operation;
			},
		}),
	};
	const view = await probe.inspectRecovery("exact:session", "owned");
	assert.deepEqual(calls, ["conversation", "receipt", "inspect"]);
	assert.equal(view.operation.operationId, "owned");
	assert.ok(!JSON.stringify(view).includes("PRIVATE_"));
	operation.conversationId = 2;
	calls.length = 0;
	await assert.rejects(
		probe.inspectRecovery("exact:session", "owned"),
		/operation_mismatch/,
	);
	assert.deepEqual(calls, ["conversation", "receipt"]);
}
