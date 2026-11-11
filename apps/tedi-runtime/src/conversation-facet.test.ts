/** Native Worker fixtures cover the actual conversation loop and durable services.
 * These tests exercise the app's passive transcript and transport projections. */
import assert from "node:assert/strict";
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
mock.module("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	RpcTarget: class {},
	tracing: {},
	exports: {},
	env: {},
}));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
const { memoryStorage, tediDo } = await import("../test/tedi-do");
const {
	PiAgent,
	sessionUserInput,
	legacySessionMessages,
	createPiEventProjection,
	piViewShowsSettlement,
} = await import("./pi-agent");
import type { SessionMessage } from "agents/sessions";
import { conversationCompactionSettings } from "./pi-compaction";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationView,
	EntryRecord,
	LiveState,
	SubmissionRecord,
} from "@earendil-works/pi-durable";

for (const cancelledAt of ["ingress", "dispatch", "never"] as const) {
	const storage = memoryStorage();
	let claims = 0,
		effects = 0;
	if (cancelledAt === "ingress") await storage.put("wfcancel:run", true);
	const parent = tediDo({
		ctx: { storage },
		state: {},
		bufferFacetToolCall: () => 1,
		activeFacetTurnTools: new Map([
			["run", { write: { execute: async () => ++effects } }],
		]),
		activeFacetTurnAuthorities: new Map(),
		activeFacetTurnConversations: new Map(),
		facetDispatchJournal: {
			claim: async () => {
				claims++;
				return true;
			},
			markReturned: async () => {},
		},
		nativeToolLedger: {
			observe: async (
				_context: unknown,
				_call: unknown,
				run: () => Promise<unknown>,
			) => {
				if (cancelledAt === "dispatch") await storage.put("wfcancel:run", true);
				return run();
			},
		},
		completeFacetToolCall: async () => {},
	});
	await parent.runtimeAdmission().beginAcceptedTurn({
		runId: "run",
		sessionKey: "unit-session",
		principalId: "unit-only-principal",
		input: { source: "unit-cancellation-fixture", tool: "write", args: {} },
		expectedGeneration: 1,
	});
	const execute = () =>
		parent.executeFacetTool({
			runId: "run",
			toolCallId: "write",
			tool: "write",
			args: {},
		});
	if (cancelledAt === "ingress") {
		await assert.rejects(execute, /canceled or stopped/);
		assert.equal(claims, 0);
	} else if (cancelledAt === "dispatch") {
		assert.match((await execute()).error, /canceled or stopped/);
		assert.equal(claims, 1);
	} else await execute();
	assert.equal(effects, cancelledAt === "never" ? 1 : 0);
}

assert.equal(sessionUserInput("hello"), "hello");
const image: SessionMessage = {
	id: "image",
	role: "user",
	parts: [
		{ type: "text", text: "inspect" },
		{
			type: "file",
			mediaType: "image/png",
			url: "data:image/png;base64,aGVsbG8=",
		},
	],
};
assert.deepEqual(sessionUserInput(image), [
	{ type: "text", text: "inspect" },
	{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
]);
const replay = legacySessionMessages({
	id: "settled",
	role: "assistant",
	parts: [
		{ type: "text", text: "Done" },
		{
			type: "dynamic-tool",
			toolName: "read",
			toolCallId: "owned-call",
			state: "output-available",
			input: { path: "/one" },
			output: { ok: true },
		},
	],
});
assert.equal(replay[0]?.role, "assistant");
assert.equal(replay[1]?.role, "toolResult");
assert.deepEqual(
	replay[0]?.role === "assistant"
		? replay[0].content.find((block) => block.type === "toolCall")
		: null,
	{
		type: "toolCall",
		id: "owned-call",
		name: "read",
		arguments: { path: "/one" },
	},
);
assert.equal(
	replay[1]?.role === "toolResult" ? replay[1].toolCallId : null,
	"owned-call",
);
assert.throws(
	() =>
		legacySessionMessages({
			id: "unfinished",
			role: "assistant",
			parts: [
				{
					type: "dynamic-tool",
					toolName: "exec",
					toolCallId: "pending",
					state: "input-available",
					input: {},
				},
			],
		}),
	/Unsettled legacy tool/,
);
assert.deepEqual(
	legacySessionMessages({
		id: "empty",
		role: "assistant",
		parts: [{ type: "step-start" }],
	}),
	[],
);
{
	// 200k fallback window: blocking compaction above 170k, background from 120k,
	// so a 180k imported history is summarized instead of resent every turn.
	const settings = conversationCompactionSettings(200_000);
	assert.equal(200_000 - settings.reserveTokens, 170_000);
	assert.equal(
		200_000 - settings.reserveTokens - settings.backgroundTokens,
		120_000,
	);
	assert.equal(settings.keepRecentTokens, 20_000);
}
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const partial: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "partial" }],
	api: "test",
	provider: "test",
	model: "test",
	timestamp: 100,
	usage,
	stopReason: "stop",
};
const view = (
	live: Omit<LiveState, "generation"> & {
		generation?: { attempt: number; message?: AssistantMessage };
	},
	entries: EntryRecord[] = [],
	before?: number,
): ConversationView =>
	({
		conversation: { id: 1 },
		entries,
		...(before === undefined ? {} : { before }),
		docs: { "pi.live": live },
	}) as unknown as ConversationView;
const entry = (
	id: number,
	model: EntryRecord["model"],
	kind = "assistant",
): EntryRecord => ({
	id: id as EntryRecord["id"],
	conversationId: 1 as EntryRecord["conversationId"],
	kind,
	model,
});
const project = createPiEventProjection();
const snapshot = project(
	view({ generation: { attempt: 1, message: partial } }),
);
const data = snapshot.find((frame) => frame.type === "data-pi-snapshot")
	?.data as { partialMessage: SessionMessage };
assert.equal(data.partialMessage.id, "pi-generation:100:1");
assert.deepEqual(data.partialMessage.parts, [
	{ type: "text", text: "partial" },
]);
assert.equal(
	snapshot
		.filter((frame) => frame.type === "text-delta")
		.map((frame) => frame.delta)
		.join(""),
	"partial",
);
assert.equal(snapshot.filter((frame) => frame.type === "start-step").length, 0);
const tailed = view({
	generation: {
		attempt: 1,
		message: { ...partial, content: [{ type: "text", text: "partial tail" }] },
	},
});
assert.deepEqual(project(tailed), [
	{ type: "text-delta", id: "0:0", delta: " tail" },
]);
assert.equal(
	project(tailed).length,
	0,
	"retained value cannot duplicate already emitted text",
);
// Watch callbacks fold commits: a partial may arrive grown, or already be an entry.
for (const type of ["text", "thinking"] as const) {
	for (const seenPartial of [false, true]) {
		const projection = createPiEventProjection();
		const block = (value: string) =>
			type === "text"
				? { type: "text" as const, text: value }
				: { type: "thinking" as const, thinking: value };
		const opened = projection(view({}));
		assert.equal(opened[0]?.type, "data-pi-snapshot");
		const start = seenPartial
			? projection(
					view({
						generation: {
							attempt: 1,
							message: { ...partial, content: [block("prefix")] },
						},
					}),
				)
			: [];
		const end = projection(
			view({}, [entry(1, [{ ...partial, content: [block("prefix tail")] }])]),
		);
		const frames = [...start, ...end];
		assert.equal(frames[0]?.type, "start-step");
		assert.equal(frames.filter((f) => f.type === "start-step").length, 1);
		assert.equal(
			frames
				.filter(
					(frame) =>
						frame.type === (type === "text" ? "text-delta" : "reasoning-delta"),
				)
				.map((frame) => frame.delta)
				.join(""),
			"prefix tail",
		);
		assert.equal(
			end.at(-2)?.type,
			type === "text" ? "text-end" : "reasoning-end",
		);
		assert.equal(end.at(-1)?.type, "finish-step");
		const retry = (value: string) =>
			view({
				generation: {
					attempt: 2,
					message: { ...partial, content: [block(value)] },
				},
			});
		assert.equal(projection(retry("rewritten"))[0]?.type, "start-step");
		assert.throws(
			() => projection(retry("other")),
			/rewrote an emitted content block/,
		);
	}
}
// Tool calls: streamed start, finalized input, settled output, run failure.
{
	const projection = createPiEventProjection();
	projection(view({}));
	const call = {
		type: "toolCall" as const,
		id: "call-1",
		name: "lookup",
		arguments: { q: "x" },
	};
	assert.deepEqual(
		projection(
			view({
				generation: {
					attempt: 1,
					message: { ...partial, content: [{ ...call, arguments: {} }] },
				},
			}),
		),
		[
			{ type: "start-step" },
			{ type: "tool-input-start", toolCallId: "call-1", toolName: "lookup" },
		],
	);
	const answer = entry(1, [
		{ ...partial, content: [call], stopReason: "toolUse" },
	]);
	const running = view(
		{ tools: [{ callId: "call-1", name: "lookup", status: "running" }] },
		[answer],
	);
	assert.deepEqual(projection(running), [
		{
			type: "tool-input-available",
			toolCallId: "call-1",
			toolName: "lookup",
			input: { q: "x" },
		},
		{ type: "finish-step" },
	]);
	const result = entry(2, [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "lookup",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 101,
		},
	]);
	const done = view(
		{
			tools: [
				{
					callId: "call-1",
					name: "lookup",
					status: "done",
					entry: result.id,
				},
			],
		},
		[answer, result],
	);
	assert.deepEqual(projection(done), [
		{
			type: "tool-output-available",
			toolCallId: "call-1",
			output: result.model,
		},
	]);
	assert.deepEqual(projection(done), []);
	const failed = view(
		{
			runFailure: {
				taskId: 7 as never,
				inputs: [],
				reason: "model_error",
				detail: "boom",
			},
		},
		[answer, result],
	);
	assert.deepEqual(projection(failed), [{ type: "error", errorText: "boom" }]);
	assert.deepEqual(projection(failed), []);
	assert.equal(
		createPiEventProjection()(failed).some((frame) => frame.type === "error"),
		false,
		"a failure already in the first value is snapshot state, not a new error",
	);
}
// Drain: a settled submission is shown once its placement is in view and its run released it.
{
	const placed = 5 as EntryRecord["id"];
	const settled = {
		id: 3,
		type: "input",
		status: "done",
		entry: placed,
		answer: 6,
	} as unknown as SubmissionRecord;
	const running = { run: { taskId: 1, inputs: [3], turns: 0 } } as never;
	assert.equal(piViewShowsSettlement(view({}), settled), false);
	assert.equal(
		piViewShowsSettlement(view(running, [entry(5, [], "user")]), settled),
		false,
	);
	assert.equal(
		piViewShowsSettlement(view({}, [entry(5, [], "user")]), settled),
		true,
	);
	assert.equal(piViewShowsSettlement(view({}, [], 9), settled), true);
	assert.equal(
		piViewShowsSettlement(view({}, [entry(5, [], "user")]), {
			...settled,
			status: "placed",
		} as SubmissionRecord),
		false,
	);
	assert.equal(
		piViewShowsSettlement(view({}), {
			id: 4,
			type: "input",
			status: "unanswered",
			reason: "withdrawn",
		} as unknown as SubmissionRecord),
		true,
	);
	assert.equal(piViewShowsSettlement(view({}), undefined), false);
}
console.log("conversation-facet native projection OK");

// Payload verification only: native registry/admission and wake semantics live in Worker fixtures.
{
	const configuration = {
		runId: "base",
		sessionKey: "session",
		aigMetadata: { orgId: "org", tediId: "tedi" },
	};
	const source = {
		parentRunId: "base",
		configuration,
		turn: { configuration, text: "original" },
	};
	const pending = {
		submissionId: "operation",
		configuration,
		turnInput: { text: "original" },
	};
	const host = Object.create(PiAgent.prototype) as any;
	host.admissionAdapter = {
		lookupAcceptedTurn: async () => ({ sessionKey: "session" }),
	};
	host.ctx = {
		storage: {
			kv: { get: () => ({ operationId: "operation" }) },
			get: async () => pending,
			sql: {
				exec: () => ({ toArray: () => [{ input: JSON.stringify(source) }] }),
			},
		},
	};
	const message = {
		id: "operation:user",
		role: "user",
		parts: [{ type: "text", text: "original" }],
	};
	await host.assertConfiguredSubmission("operation", message);
	await assert.rejects(
		host.assertConfiguredSubmission("operation", {
			...message,
			parts: [{ type: "text", text: "forged" }],
		}),
		/changed accepted input/,
	);
	await assert.rejects(
		host.assertConfiguredSubmission("other-operation", message),
		/outside the accepted operation/,
	);
}

// The unit adapter never invents an original claim when a guard is consulted.
{
	const parent = tediDo(),
		admission = parent.runtimeAdmission();
	await assert.rejects(
		admission.assertAcceptedTurn({ runId: "unknown" }),
		/missing/,
	);
	const input = {
		runId: "owned-unit-run",
		sessionKey: "unit-session",
		principalId: "unit-only-principal",
		input: { text: "immutable" },
		expectedGeneration: 1,
	};
	await admission.beginAcceptedTurn(input);
	await assert.rejects(
		admission.beginAcceptedTurn({ ...input, input: { text: "changed" } }),
		/changed/,
	);
	admission.gate.quarantine();
	await assert.rejects(
		admission.assertAcceptedTurn({ runId: input.runId }),
		/inactive/,
	);
	assert.equal(
		(
			await admission.assertOriginalClaim({
				runId: input.runId,
				input: input.input,
			})
		).runId,
		input.runId,
	);
	await assert.rejects(
		admission.assertOriginalClaim({
			runId: input.runId,
			input: { text: "changed" },
		}),
		/changed/,
	);
	const receipt = await admission.recordTerminalReceipt(input.runId, {
		sourceId: "unit-original",
		receipt: { terminal: "completed" },
	});
	admission.gate.completeTurn({
		turnId: input.runId,
		generation: receipt.generation,
		requestHash: receipt.requestHash,
	});
	assert.equal(admission.read().state, "quarantined");
}
