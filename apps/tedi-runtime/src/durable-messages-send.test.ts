/** Durable acknowledgement and idempotent replay contracts. */
import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { runEventsToTaskState } from "@tedix/mcp-shared/tasks";
import {
	recordQueuedChatTurn,
	settledChatTurnReceipt,
	chatTurnErrorResponse,
	ChatTurnReceiptError,
	isDuplicateWorkflowInstanceError,
} from "./durable-messages-send";

// ── Duplicate-instance classifier ─────────────────────────────────────────────
// Cloudflare Workflows duplicate create() rejections.
assert.equal(
	isDuplicateWorkflowInstanceError(new Error("instance.already_exists")),
	true,
	"CF error code shape",
);
assert.equal(
	isDuplicateWorkflowInstanceError(
		new Error('Workflow instance with ID "wf-abc" already exists.'),
	),
	true,
	"CF message shape",
);
// Agents SDK tracking-table UNIQUE-conflict wrapper.
assert.equal(
	isDuplicateWorkflowInstanceError(
		new Error('Workflow with ID "wf-abc" is already being tracked'),
	),
	true,
	"agents SDK tracking duplicate",
);
// Real dispatch failures must NOT classify as duplicates (they take the
// error path).
assert.equal(
	isDuplicateWorkflowInstanceError(
		new Error("Workflow binding 'CHAT_TURN_WORKFLOW' not found in environment"),
	),
	false,
	"missing binding is a dispatch failure",
);
assert.equal(
	isDuplicateWorkflowInstanceError(
		new Error("Could not detect Agent binding name from class name."),
	),
	false,
	"agent-binding detection failure is a dispatch failure",
);
assert.equal(isDuplicateWorkflowInstanceError(null), false, "null-safe");
assert.equal(
	isDuplicateWorkflowInstanceError("instance.already_exists"),
	true,
	"bare-string throw",
);
console.log("PASS: isDuplicateWorkflowInstanceError");

// ── Dangling-turn detector (adoption-review backlog #4 telemetry) ─────────────
{
	const { findDanglingUserTurnAgeMs, DANGLING_TURN_LEASE_MS } =
		await import("./durable-messages-send");
	const now = 10_000_000;
	assert.equal(
		findDanglingUserTurnAgeMs([], now),
		null,
		"empty session → null",
	);
	assert.equal(
		findDanglingUserTurnAgeMs(
			[
				{ role: "user", ts: 1 },
				{ role: "assistant", ts: 2 },
			],
			now,
		),
		null,
		"assistant-terminated session is healthy",
	);
	assert.equal(
		findDanglingUserTurnAgeMs([{ role: "user", ts: now - 1000 }], now),
		null,
		"fresh trailing user turn is within the lease",
	);
	assert.equal(
		findDanglingUserTurnAgeMs(
			[{ role: "user", ts: now - DANGLING_TURN_LEASE_MS - 5 }],
			now,
		),
		DANGLING_TURN_LEASE_MS + 5,
		"stale trailing user turn returns its age",
	);
	assert.equal(
		findDanglingUserTurnAgeMs([{ role: "user", ts: now - 500 }], now, 400),
		500,
		"custom lease is honored",
	);
	console.log("PASS: findDanglingUserTurnAgeMs detector");
}

const events = new Map<string, TediRuntimeEvent>();
const platform = {
	async recordRuntimeEvent(event: TediRuntimeEvent) {
		if (!events.has(event.id)) events.set(event.id, event);
	},
	async listRuntimeEvents({ runId }: { runId: string }) {
		return { events: [...events.values()].filter((e) => e.runId === runId) };
	},
};
const input = {
	tediId: "tedi",
	runId: "run",
	conversationId: "cto:chat",
	sessionKey: "chat",
	userTs: 1234,
};
await recordQueuedChatTurn(platform, input);
assert.equal(events.get("run:1")?.payload?.status, "queued");
assert.equal(
	runEventsToTaskState("run", [...events.values()]).status,
	"working",
);
await recordQueuedChatTurn(platform, { ...input, userTs: 5678 });
assert.equal(
	events.size,
	1,
	"redelivery reuses the canonical lifecycle identity",
);
assert.equal(events.get("run:1")?.createdAt, new Date(1234).toISOString());
assert.deepEqual(
	await settledChatTurnReceipt(platform, {
		runId: "run",
		sessionKey: "chat",
		assistant: { content: "cached reply", ts: 1234 },
	}),
	{
		ok: true,
		run_id: "run",
		session_key: "chat",
		assistant: null,
		pending: true,
	},
);
const failure: TediRuntimeEvent = {
	...events.get("run:1")!,
	id: "run:3",
	kind: "run.failed",
	payload: { error: "model failed" },
};
events.set(failure.id, failure);
await recordQueuedChatTurn(platform, input);
assert.equal(
	runEventsToTaskState("run", [...events.values()]).status,
	"failed",
	"queued replay must not resurrect a terminal run",
);
await assert.rejects(
	settledChatTurnReceipt(platform, {
		runId: "run",
		sessionKey: "chat",
		assistant: { content: "cached reply", ts: 1234 },
	}),
	/run failed/,
);
events.set(failure.id, { ...failure, kind: "run.canceled" });
await assert.rejects(
	settledChatTurnReceipt(platform, {
		runId: "run",
		sessionKey: "chat",
		assistant: { content: "cached reply", ts: 1234 },
	}),
	/run cancelled/,
);
events.set(failure.id, { ...failure, kind: "run.completed" });
assert.deepEqual(
	await settledChatTurnReceipt(platform, {
		runId: "run",
		sessionKey: "chat",
		assistant: { content: "cached reply", ts: 1234 },
	}),
	{
		ok: true,
		run_id: "run",
		session_key: "chat",
		assistant: { role: "assistant", content: "cached reply", ts: 1234 },
	},
);
await assert.rejects(
	recordQueuedChatTurn(null, input),
	/run.*acknowledgement is unknown/,
);
await assert.rejects(
	recordQueuedChatTurn(
		{
			async recordRuntimeEvent() {
				throw new Error("D1 unavailable");
			},
		},
		input,
	),
	/run.*acknowledgement is unknown/,
);
const gate = Promise.withResolvers<void>();
let acknowledged = false;
const pending = recordQueuedChatTurn(
	{
		async recordRuntimeEvent() {
			await gate.promise;
		},
	},
	input,
).then(() => {
	acknowledged = true;
});
await Promise.resolve();
assert.equal(
	acknowledged,
	false,
	"acknowledgement must await ledger publication",
);
gate.resolve();
await pending;
assert.equal(acknowledged, true);
await recordQueuedChatTurn(null, { ...input, sessionKey: "__test:temporary" });
assert.equal(
	(
		await settledChatTurnReceipt(null, {
			runId: "run",
			sessionKey: "__test:temporary",
			assistant: { content: "ephemeral", ts: 0 },
		})
	).assistant?.content,
	"ephemeral",
);
console.log(
	"PASS: durable ledger acknowledgement, publication failure, terminal replay, ephemeral sessions",
);

await assert.rejects(
	settledChatTurnReceipt(
		{
			async listRuntimeEvents() {
				return { events: [] };
			},
		},
		{ runId: "run", sessionKey: "chat", assistant: { content: "done", ts: 0 } },
	),
	/canonical outcome is unknown/,
);
for (const error of [
	new Error("ledger unavailable"),
	new ChatTurnReceiptError("failed", "failed"),
]) {
	const response = chatTurnErrorResponse(error, {
		runId: "run",
		sessionKey: "chat",
		clientRequestId: "stable",
	});
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), {
		ok: false,
		success: false,
		error: error.message,
		run_id: "run",
		session_key: "chat",
		client_request_id: "stable",
		outcome: error instanceof ChatTurnReceiptError ? "failed" : "unknown",
	});
}
