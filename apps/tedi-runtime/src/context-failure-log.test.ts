import { privateInferenceOriginGuard } from "./runtime-inference-origin";
import assert from "node:assert/strict";
import { composeCognitiveAddenda } from "./cognitive-addenda";
import {
	logTediContextFailure,
	logTediSourceFailure,
} from "./context-failure-log";
import { observerCompletion } from "./observer-llm";

const secret = "prompt, memory, skill and credential: private-value";
const failure = new Error(secret, { cause: new TypeError(secret) });
failure.name = `Untrusted ${secret}`;
const warnings: unknown[][] = [];
const originalWarn = console.warn;
const errors: unknown[][] = [];
const originalError = console.error;
console.warn = (...args: unknown[]) => warnings.push(args);
console.error = (...args: unknown[]) => errors.push(args);

try {
	logTediContextFailure("tedi.context.addendum_failed", failure, {
		block: "brainDigest",
	});
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime-context",
			event: "tedi.context.addendum_failed",
			block: "brainDigest",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	logTediSourceFailure("skill_guidance", "build", failure);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime-context",
			event: "tedi.context.source_failed",
			source: "skill_guidance",
			operation: "build",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	logTediSourceFailure("memory_recall", "query", failure, "error");
	assert.deepEqual(errors.pop(), [
		{
			component: "tedi-runtime-context",
			event: "tedi.context.source_failed",
			source: "memory_recall",
			operation: "query",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);

	const reads: string[] = [];
	const sources = {
		directives: async () => {
			reads.push("directives");
			return "directives survive";
		},
		brainDigest: async () => {
			reads.push("brainDigest");
			throw failure;
		},
		skillGuidance: async () => {
			reads.push("skillGuidance");
			return "skill guidance survives";
		},
		retrievedSkills: async () => {
			reads.push("retrievedSkills");
			return "retrieved skill survives";
		},
	};
	const addenda = await composeCognitiveAddenda({
		sessionKey: "agent:main:main",
		sources,
		onComposition: () => {},
	});
	assert.equal(
		addenda,
		"directives survive\n\nskill guidance survives\n\nretrieved skill survives",
	);
	assert.deepEqual(reads, [
		"directives",
		"brainDigest",
		"skillGuidance",
		"retrievedSkills",
	]);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime-context",
			event: "tedi.context.addendum_failed",
			block: "brainDigest",
			exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
		},
	]);
	for (const sessionKey of ["evidence:judge:run-1", "workflow:synth:run-1"]) {
		reads.length = 0;
		assert.equal(
			await composeCognitiveAddenda({
				sessionKey,
				sources,
				onComposition: () => {},
			}),
			"",
		);
		assert.deepEqual(reads, []);
	}

	let workersAiCalls = 0;
	const result = await observerCompletion({
		env: {
			AI_GATEWAY_ACCOUNT_ID: "fixture-account",
			AI_GATEWAY_LLM_ID: "fixture-gateway",
			AI: {
				run: async () => {
					workersAiCalls++;
					return { response: '{"ok":true}' };
				},
			},
			SECRETS_MASTER_KEY: "fixture-signing-secret",
			TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
			API_SERVICE: {
				fetch: async () =>
					Response.json({
						json: {
							allowed: true,
							settlementMode: "disabled",
							attributionVersion: 3,
							executionId: "12345678-1234-4123-8123-123456789abc",
							sendBefore: "2099-01-01T00:00:00.000Z",
							reservationId: null,
							expiresAt: null,
							estimatedChargeMicros: null,
						},
					}),
			},
		},
		modelRef: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
		beforeDispatch: fixtureOriginGuard("fixture-org"),
		metadata: {
			orgId: "fixture-org",
			tediId: "fixture-tedi",
			source: "observer:post-turn",
		},
		messages: [{ role: "user", content: secret }],
	} as never);
	assert.equal(result, '{"ok":true}');
	assert.equal(workersAiCalls, 1);
	assert.equal(warnings.length, 0);
	assert.equal(errors.length, 0);
} finally {
	console.warn = originalWarn;
	console.error = originalError;
}

console.log(
	"PASS: context failures remain private and configured observer stays functional",
);

// Scripted fixture assertion; this is not evidence of a production Durable Object.
function fixtureOriginGuard(orgId = "org", recheck: () => void = () => {}) {
	const owner = { orgId, tediId: "fixture-tedi", objectId: "a".repeat(64) };
	return privateInferenceOriginGuard(
		{
			kind: "unselected_native",
			root: {
				owner,
				objectName: "fixture-root",
				className: "AgentTediDO",
				path: [],
				generation: 0,
			},
			selected: {
				owner,
				className: "AgentTediDO",
				identityName: "fixture-root",
				facetName: null,
				path: [],
				generation: 0,
			},
			configurationHash: "b".repeat(64),
		},
		recheck,
	);
}
