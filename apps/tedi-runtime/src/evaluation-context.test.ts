import assert from "node:assert/strict";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import {
	authorizeEvaluation,
	admitEvaluation,
	evaluationSystem,
	evaluationNativeSystem,
	type EvaluationAdmission,
} from "./evaluation-context";
import {
	evaluationOutputShape,
	recordEvaluationEvidence,
	recordEvaluationOutcome,
	type EvaluationDispatchEvidence,
} from "./evaluation-evidence";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

const request = {
	policy: "isolated-evaluation-v1",
	reviewedAgentsSha256: await sha256Hex("Keep customer information private."),
} as const;
const run = {
	id: "workflow-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	executionEpoch: 2,
	certification: true,
	workItemId: "work-1",
	skillId: "skill-1",
	skillRevision: 3,
	workflowSourceHash: "a".repeat(64),
	status: "running",
	workflowRetiredAt: null,
	params: {
		evaluationAdmission: {
			...request,
			skillRevision: 3,
			workAttemptId: "00000000-0000-4000-8000-000000000001",
		},
	},
} as unknown as NonNullable<Parameters<typeof authorizeEvaluation>[0]["run"]>;
const scope = {
	request,
	run,
	orgId: "org-1",
	tediId: "tedi-1",
	workflowRunId: "workflow-1",
	executionEpoch: 2,
};
const admission: EvaluationAdmission = {
	...authorizeEvaluation(scope),
	agents: "Keep customer information private.",
};
for (const change of [
	{ organizationId: "other" },
	{ tediId: "other" },
	{ id: "other" },
	{ executionEpoch: 3 },
	{ certification: false },
	{ workItemId: null },
	{ status: "canceled" },
	{ workflowRetiredAt: "2026-01-01" },
	{ skillRevision: 4 },
	{ workflowSourceHash: null },
	{ params: {} },
	{
		params: {
			evaluationAdmission: {
				...(run.params!.evaluationAdmission as object),
				workAttemptId: "wrong",
			},
		},
	},
])
	assert.throws(
		() =>
			authorizeEvaluation({
				...scope,
				run: { ...run, ...change } as typeof run,
			}),
		/certified/,
	);
assert.throws(
	() =>
		authorizeEvaluation({
			...scope,
			request: { ...request, reviewedAgentsSha256: "b".repeat(64) },
		}),
	/certified/,
);

// A public caller cannot manufacture workflow authority from provenance headers.
await assert.rejects(
	admitEvaluation({
		request: new Request("https://runtime.example/mcp", {
			headers: {
				[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
					method: "api-key",
					principalType: "api_key",
					principalId: "caller",
					scopes: ["*"],
				}),
				"X-Tedix-Skill-Run-Id": "workflow-1",
				"X-Tedix-Workflow-Execution-Epoch": "2",
			},
		}),
		evaluation: request,
		orgId: "org-1",
		tediId: "tedi-1",
		env: {} as Cloudflare.Env,
	}),
	/authenticated workflow/,
);

const userText = "Evaluate this blinded case using the supplied fixed rules.";
const evidence: EvaluationDispatchEvidence = {
	runId: "child-1",
	sessionKey: "workflow:synth:evaluation:child-1",
	admission,
	providerAttempt: { runId: "child-1", attemptId: "attempt-1" },
	prompt: [
		{ role: "system", content: evaluationNativeSystem(admission) },
		{
			role: "user",
			content: [{ type: "text", text: wrapUntrustedInput(userText, "mcp") }],
		},
	],
	tools: [],
	toolChoice: { type: "none" },
	model: { provider: "fixture", model: "judge" },
};
const writes: Array<{ type: string; value: unknown }> = [];
const host = {
	tediId: "tedi-1",
	slug: "fixture",
	admitted: admission,
	userText,
	platform: {
		recordArtifact: async (value: unknown) => {
			writes.push({ type: "artifact", value });
		},
		recordRuntimeEvent: async (value: unknown) => {
			writes.push({ type: "event", value });
		},
	},
};
await recordEvaluationEvidence(evidence, host);
assert.deepEqual(
	writes.map((w) => w.type),
	["artifact", "event"],
);
const artifact = writes[0]!.value as {
	content: string;
	accessClassification: string;
};
const body = JSON.parse(artifact.content);
assert.equal(artifact.accessClassification, "runtime_private");
assert.equal(
	body.finalInputSha256,
	await sha256Hex(JSON.stringify(body.finalInput)),
);
assert.deepEqual(body.finalInput.prompt, evidence.prompt);
assert.equal(body.manifest.historyMessages, 0);
assert.deepEqual(body.manifest.toolDescriptors, []);
assert.equal(body.manifest.skillRevision, 3);
assert.ok(body.manifest.excluded.includes("retrievedSkills"));
for (const change of [
	{ sessionKey: "old-session" },
	{ admission: { ...admission, agents: "leaked held-out label" } },
	{ providerAttempt: { runId: "other", attemptId: "attempt-1" } },
	{ tools: [{ type: "function", name: "read_memory", inputSchema: {} }] },
	{
		prompt: [
			...evidence.prompt,
			{
				role: "assistant",
				content: [{ type: "text", text: "previous answer" }],
			},
		],
	},
	{
		prompt: [
			{
				role: "system",
				content: `${evaluationSystem(admission)}\nHidden label: accepted`,
			},
			evidence.prompt[1],
		],
	},
	{
		prompt: [
			evidence.prompt[0],
			{ role: "user", content: [{ type: "text", text: "changed case" }] },
		],
	},
]) {
	writes.length = 0;
	await assert.rejects(
		recordEvaluationEvidence(
			{ ...evidence, ...change } as EvaluationDispatchEvidence,
			host,
		),
	);
	assert.equal(writes.length, 0);
}
for (const failure of ["artifact", "event"]) {
	await assert.rejects(
		recordEvaluationEvidence(evidence, {
			...host,
			platform: {
				recordArtifact: async () => {
					if (failure === "artifact") throw new Error("write failed");
				},
				recordRuntimeEvent: async () => {
					if (failure === "event") throw new Error("write failed");
				},
			},
		}),
		/write failed/,
	);
}

const receiptWrites: unknown[] = [];
const preparedKey = "evaluation-context:child-1:attempt-1";
const prepared = {
	artifactId: "child-1:artifact:v2:evaluation-context:attempt-1",
	finalInputSha256: body.finalInputSha256,
	conversationId: "fixture:workflow:synth:evaluation:child-1",
};
const receiptHost = {
	tediId: "tedi-1",
	storage: {
		get: async (key: string) => (key === preparedKey ? prepared : undefined),
	},
	platform: {
		recordRuntimeEvent: async (value: unknown) => {
			receiptWrites.push(value);
		},
	},
};
await recordEvaluationOutcome(
	{
		providerAttempt: evidence.providerAttempt,
		finishReason: "stop",
		responseId: null,
		responseModel: null,
		usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
		outputShape: evaluationOutputShape({
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "private answer" },
			],
		}),
		privateMetadata: "must not persist",
	} as Parameters<typeof recordEvaluationOutcome>[0],
	receiptHost as Parameters<typeof recordEvaluationOutcome>[1],
);
assert.equal(receiptWrites.length, 1);
const receipt = receiptWrites[0] as { payload: Record<string, unknown> };
assert.deepEqual(receipt.payload.outputShape, {
	measurementBoundary: "pi-adapter-final-assistant-message-v1",
	textPartCount: 1,
	textChars: 14,
	reasoningPartCount: 1,
	reasoningChars: 17,
});
assert.equal(receipt.payload.artifactId, prepared.artifactId);
assert.equal(receipt.payload.finalInputSha256, prepared.finalInputSha256);
assert.deepEqual(receipt.payload.providerAttempt, evidence.providerAttempt);
assert.equal(JSON.stringify(receipt).includes("private reasoning"), false);
assert.equal(JSON.stringify(receipt).includes("private answer"), false);
assert.equal(JSON.stringify(receipt).includes("must not persist"), false);

for (const rejected of [
	{
		providerAttempt: { runId: "foreign-run", attemptId: "attempt-1" },
		outputShape: evaluationOutputShape({ content: [] }),
	},
	{
		providerAttempt: evidence.providerAttempt,
		outputShape: {
			measurementBoundary: "pi-adapter-final-assistant-message-v1",
			textPartCount: -1,
			textChars: 0,
			reasoningPartCount: 0,
			reasoningChars: 0,
		},
	},
]) {
	const writesBefore: number = receiptWrites.length;
	await assert.rejects(
		recordEvaluationOutcome(
			{
				finishReason: "stop",
				responseId: null,
				responseModel: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				...rejected,
			} as Parameters<typeof recordEvaluationOutcome>[0],
			receiptHost as Parameters<typeof recordEvaluationOutcome>[1],
		),
	);
	assert.equal(receiptWrites.length, writesBefore);
}

receiptWrites.length = 0;
await recordEvaluationOutcome(
	{
		providerAttempt: evidence.providerAttempt,
		finishReason: "stop",
		responseId: null,
		responseModel: null,
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		outputShape: null,
	},
	receiptHost as Parameters<typeof recordEvaluationOutcome>[1],
);
assert.equal(
	(receiptWrites[0] as { payload: { outputShape: unknown } }).payload
		.outputShape,
	null,
);
console.log("evaluation-context OK");
