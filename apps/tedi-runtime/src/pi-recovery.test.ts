import assert from "node:assert/strict";
import { PiTurnAccounting } from "./pi-turn-accounting";
import { memoryStorage, tediDo } from "../test/tedi-do";
import { assertTediChatNotCanceled } from "./pi-recovery";

// Native durable scheduling, recovery and tool reservations are proved by
// test/pi/native-facet.workerd.test.ts; pure cancellation fencing remains here.
// Recovery authorization precedes a delayed alarm. Cancellation can win in
// between, and must prevent the model call even after that earlier approval.
const canceled = new Set<string>();
const isCanceled = async (id: string) => canceled.has(id);
canceled.add("late-cancel");
let modelCalls = 0;
await assert.rejects(async () => {
	await assertTediChatNotCanceled("late-cancel", isCanceled);
	modelCalls++;
}, /canceled or stopped/);
assert.equal(modelCalls, 0);
await assertTediChatNotCanceled("fresh-admission", isCanceled);
for (const id of [null, undefined, "", " "]) {
	await assert.rejects(
		assertTediChatNotCanceled(id, isCanceled),
		/run identity/,
	);
}
await assert.rejects(
	assertTediChatNotCanceled("run-1", async () => {
		throw new Error("cancellation storage unavailable");
	}),
	/cancellation storage unavailable/,
);
// The parent's cancellation gate reads the durable tombstone and fails
// closed; native provider admission consults it before dispatch.
{
	const storage = memoryStorage({ "wfcancel:run-canceled": { runId: "x" } });
	const agent = tediDo({ ctx: { storage } });
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "run-live",
		sessionKey: "main",
		principalId: agent.state.tediId,
		input: { kind: "original-chat-turn", text: "live" },
		expectedGeneration: 1,
	});
	await agent.assertChatTurnActive("run-live");
	await assert.rejects(
		agent.assertChatTurnActive("unknown-run"),
		/identity changed or missing/,
	);
	await assert.rejects(
		agent.assertChatTurnActive("run-canceled"),
		/canceled or stopped/,
	);
	storage.get = async () => {
		throw new Error("cancellation storage unavailable");
	};
	await assert.rejects(
		agent.assertChatTurnActive("run-live"),
		/cancellation storage unavailable/,
	);
}
// The same durable journal used by native provider preparation rejects a
// canceled run before reserving or dispatching a model request.
{
	const asked: string[] = [];
	let reserved = 0;
	const accounting = new PiTurnAccounting(
		memoryStorage() as unknown as ConstructorParameters<
			typeof PiTurnAccounting
		>[0],
		{
			assertActive: async (runId) => {
				asked.push(runId);
				throw new Error(`run ${runId} canceled or stopped`);
			},
			reserveStep: async () => {
				reserved++;
				return { stepId: "denied" };
			},
			recordStep: async () => {},
		},
	);
	await assert.rejects(accounting.begin("run-canceled"), /canceled or stopped/);
	assert.deepEqual(asked, ["run-canceled"]);
	assert.equal(reserved, 0);
}
console.log("pi-recovery OK");
