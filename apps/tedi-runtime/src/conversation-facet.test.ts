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
} = await import("./pi-agent");
import type { SessionMessage } from "agents/sessions";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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
const project = createPiEventProjection();
const snapshot = project({
	type: "snapshot",
	entries: [],
	generation: { attempt: 1, message: partial },
	tools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
});
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
const delta = project({
	type: "message_update",
	usage,
	changes: [{ type: "text_delta", contentIndex: 0, delta: " tail" }],
});
assert.deepEqual(delta, [{ type: "text-delta", id: "0:0", delta: " tail" }]);
assert.equal(
	project({
		type: "snapshot",
		entries: [],
		generation: {
			attempt: 1,
			message: {
				...partial,
				content: [{ type: "text", text: "partial tail" }],
			},
		},
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	}).filter((frame) => frame.type === "text-delta").length,
	0,
	"retained snapshot cannot duplicate already emitted text",
);
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
