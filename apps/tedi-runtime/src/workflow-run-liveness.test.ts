import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { HttpPlatformClient } from "./brain/platform-client";
import type { FacetWorkflowTurnInput } from "./delegated-work-lease";
import { memoryStorage, tediDo } from "../test/tedi-do";
import {
	workflowRunIsTerminal,
	withWorkflowTurnLiveness,
	WORKFLOW_TURN_HEARTBEAT_MS,
} from "./workflow-run-liveness";

const input: FacetWorkflowTurnInput = {
	runId: "run-1",
	sessionKey: "delegated:home-1",
	conversationId: "cto:delegated:home-1",
	userText: "Inspect the failure",
	userTs: 1,
	workflowInstanceId: "workflow-1",
};

for (const kind of ["run.completed", "run.failed", "run.canceled"] as const) {
	const terminal: TediRuntimeEvent = {
		id: "terminal-1",
		tediId: "cto",
		runId: input.runId,
		kind,
		createdAt: "2026-10-28T16:06:59.000Z",
	};
	// Exercise HTTP forwarding of the kind filter, including a terminal older
	// than the latest 500 retry rows from the reported failure.
	const ledger: TediRuntimeEvent[] = [
		...Array.from({ length: 600 }, (_, i) => ({
			...terminal,
			id: `retry-${i}`,
			kind: "step.retry" as const,
			createdAt: "2026-10-30T21:57:00.000Z",
		})),
		terminal,
	];
	const filters: unknown[] = [];
	const client = new HttpPlatformClient({
		apiBaseUrl: "https://api.example.test",
		apiAuthMode: "service-binding",
		tediId: "cto",
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)).json;
			assert.equal(body.runId, input.runId);
			assert.equal(body.tediId, "cto");
			filters.push(body.kind);
			return Response.json({
				json: {
					events: ledger
						.filter((event) => event.kind === body.kind)
						.slice(0, body.limit),
				},
			});
		},
	});
	assert.equal(await workflowRunIsTerminal(client, input.runId), true);
	assert.deepEqual(filters.sort(), [
		"run.canceled",
		"run.completed",
		"run.failed",
	]);
	const { workflowInstanceId, ...original } = input;
	const storage = memoryStorage({
		[`runtime-admission-workflow:${input.runId}`]: {
			id: workflowInstanceId,
			params: original,
		},
		[`wfctx:${workflowInstanceId}`]: { ...original, redriveNotBefore: 1 },
	});
	const calls: string[] = [];
	const agent = tediDo({
		ctx: { storage },
		ensureIdentity: async () => {},
		getPlatformClient: async () => client,
		keepAliveWhile: (run: () => Promise<unknown>) => run(),
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		runFacetWorkflowTurnImpl: async () => {
			throw new Error("terminal run reached model");
		},
		restartWorkflow: async () => {
			throw new Error("terminal run restarted");
		},
		recordWorkflowRetryOwnership: async () => {
			throw new Error("terminal run wrote retry");
		},
		settleWorkflowFailure: async () => {
			throw new Error("existing outcome overwritten");
		},
		settleWorkflowSuccess: async () => {
			throw new Error("existing outcome overwritten");
		},
		clearWorkflowDispatch: async (id: string) => {
			calls.push(`clear:${id}`);
		},
		clearFanoutSlot: async (id: string) => {
			calls.push(`slot:${id}`);
		},
	});
	const result = await agent.runFacetWorkflowTurn(input);
	assert.equal(result.stopReason, "run_terminal");
	await agent.onWorkflowComplete(
		"CHAT_TURN_WORKFLOW",
		workflowInstanceId,
		result,
	);
	await agent.onWorkflowError(
		"CHAT_TURN_WORKFLOW",
		workflowInstanceId,
		"Durable Object reset because its code was updated.",
	);
	await agent.redriveTransientWorkflow(
		`wfctx:${workflowInstanceId}`,
		original,
		workflowInstanceId,
		"isolate exceeded its memory limit",
	);
	await agent.reconcileChatWorkflowStart({ workflowInstanceId, attempt: 0 });
	assert.deepEqual(
		calls,
		Array.from({ length: 4 }, () => [
			`clear:${workflowInstanceId}`,
			`slot:${workflowInstanceId}`,
		]).flat(),
	);
}
await assert.rejects(
	workflowRunIsTerminal(null, input.runId),
	/ledger unavailable/,
);
await assert.rejects(
	workflowRunIsTerminal(
		{
			listRuntimeEvents: async () => {
				throw new Error("read unavailable");
			},
		},
		input.runId,
	),
	/read unavailable/,
);
assert.equal(
	await workflowRunIsTerminal(
		{ listRuntimeEvents: async () => ({ events: [] }) },
		input.runId,
	),
	false,
);

// Drive the production cadence without waiting wall-clock minutes.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, () => void>();
let nextTimer = 0;
globalThis.setTimeout = ((callback: () => void, delay: number) => {
	assert.equal(delay, WORKFLOW_TURN_HEARTBEAT_MS);
	timers.set(++nextTimer, callback);
	return nextTimer;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => {
	timers.delete(id);
}) as typeof clearTimeout;
try {
	for (const fails of [false, true]) {
		const events: TediRuntimeEvent[] = [];
		let finish!: () => void;
		const turn = withWorkflowTurnLiveness(
			input,
			{
				recordRuntimeEvent: async (event) => {
					events.push(event);
				},
			},
			"cto",
			async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				if (fails) throw new Error("model failed");
				return "answer";
			},
		);
		for (let minute = 1; minute <= 20; minute++) {
			const [id, callback] = [...timers][0]!;
			timers.delete(id);
			callback();
			for (let i = 0; i < 5; i++) await Promise.resolve();
			assert.equal(events.length, minute);
			assert.equal(timers.size, 1);
		}
		assert.ok(WORKFLOW_TURN_HEARTBEAT_MS < 12 * 60_000);
		assert.ok(
			events.every(
				(event) =>
					event.kind === "message.progress" &&
					event.runId === input.runId &&
					event.conversationId === input.conversationId,
			),
		);
		assert.equal(new Set(events.map((event) => event.id)).size, 20);
		finish();
		if (fails) await assert.rejects(turn, /model failed/);
		else assert.equal(await turn, "answer");
		assert.equal(timers.size, 0, "settlement removes the liveness timer");
	}
	// The actual facet RPC path must arm the heartbeat around its model call.
	{
		const { workflowInstanceId, ...original } = input;
		let finish!: () => void;
		const events: TediRuntimeEvent[] = [];
		const agent = tediDo({
			state: { tediId: "cto" },
			ctx: {
				storage: memoryStorage({
					[`runtime-admission-workflow:${input.runId}`]: {
						id: workflowInstanceId,
						params: original,
					},
				}),
			},
			ensureIdentity: async () => {},
			assertChatTurnActive: async () => {},
			keepAliveWhile: (run: () => Promise<unknown>) => run(),
			sessionRepo: { findTurnByIdempotencyKey: () => null },
			getPlatformClient: async () => ({
				listRuntimeEvents: async () => ({ events: [] }),
				recordRuntimeEvent: async (event: TediRuntimeEvent) => {
					events.push(event);
				},
			}),
			runFacetWorkflowTurnImpl: async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return { text: "answer", stopReason: "stop", toolCalls: [] };
			},
		});
		const turn = agent.runFacetWorkflowTurn(input);
		for (let i = 0; i < 30; i++) await Promise.resolve();
		assert.equal(timers.size, 1);
		const [id, callback] = [...timers][0]!;
		timers.delete(id);
		callback();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.equal(events.length, 1);
		finish();
		assert.equal((await turn).text, "answer");
		assert.equal(timers.size, 0);
	}
	assert.equal(
		await withWorkflowTurnLiveness(
			{ ...input, sessionKey: "__test:quiet" },
			{
				recordRuntimeEvent: async () => {
					throw new Error("ephemeral ledger write");
				},
			},
			"cto",
			async () => "ephemeral",
		),
		"ephemeral",
	);
	assert.equal(timers.size, 0);
} finally {
	globalThis.setTimeout = realSetTimeout;
	globalThis.clearTimeout = realClearTimeout;
}
console.log("PASS: terminal workflow fences and silent-round liveness");
