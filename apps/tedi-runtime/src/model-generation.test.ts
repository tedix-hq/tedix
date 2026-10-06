import { privateInferenceOriginGuard } from "./runtime-inference-origin";
/** Provider and Computer SDK imports require workerd; test:provider executes this script. */
import assert from "node:assert/strict";
import { createAzure } from "@ai-sdk/azure";
import {
	convertToModelMessages,
	dynamicTool,
	jsonSchema,
	generateText,
	streamText,
	type UIMessage,
} from "ai";
import type { PlatformClient } from "./brain/platform-client";
import { ListWorkApprovalInboxInputSchema } from "@tedix/api-contract/schemas/work-approvals";
import { createWorkApprovalAiTools } from "./work-approval-tools";
import { describeFacetTools } from "./facet-tool-descriptors";
import { azureModel as nativeAzureModel } from "./ai-sdk-adapter";
import type { AzureChatEnv } from "./llm";
import { resolveFacetGeneration } from "./facet-generation-settings";
import {
	assertModelRequestSettings,
	modelRequestTelemetry,
	type ModelRequestTelemetry,
} from "./model-request-telemetry";

import { responsesFixtureStream } from "../test/pi-runtime/responses-recovery-fixture";

const modelId = "gpt-5.6-terra";
const observed: { url: string; body: Record<string, any>; headers: Headers }[] =
	[];
const authorizations: Record<string, any>[] = [];
const env = {
	AZURE_OPENAI_RESOURCE: "test-resource",
	AZURE_CHAT_DEPLOYMENT: modelId,
	AZURE_OPENAI_API_VERSION: "2025-03-01-preview",
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_LLM_ID: "test-gateway",
	AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
	SECRETS_MASTER_KEY: "fixture-signing-secret",
	TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	AI: {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			observed.push({
				url: request.url,
				body: (await request.json()) as Record<string, any>,
				headers: request.headers,
			});
			const body = observed.at(-1)!.body;
			if (body.stream) return responsesFixtureStream(2);
			return Response.json({
				id: "resp-test",
				object: "response",
				created_at: 1,
				model: modelId,
				status: "completed",
				output: [
					{
						type: "message",
						id: "msg-test",
						role: "assistant",
						content: [{ type: "output_text", text: "ok", annotations: [] }],
					},
				],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			});
		},
	},
	API_SERVICE: {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			authorizations.push(
				(await new Request(input, init).json()) as Record<string, any>,
			);
			return Response.json({
				json: {
					allowed: true,
					settlementMode: "disabled",
					attributionVersion: 3,
					executionId: crypto.randomUUID(),
					sendBefore: "2099-01-01T00:00:00.000Z",
					reservationId: null,
					expiresAt: null,
					estimatedChargeMicros: null,
				},
			});
		},
	},
} as unknown as AzureChatEnv;
let wire: ModelRequestTelemetry = null;
const model = azureModel(
	env,
	{ orgId: "00000000-0000-4000-8000-000000000001", source: "ci" },
	(x) => {
		wire = x;
	},
).responses(modelId);
const prompt = [
	{
		role: "user" as const,
		content: [{ type: "text" as const, text: "hello" }],
	},
];
const efforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
for (const effort of efforts) {
	const settings = resolveFacetGeneration(
		{ provider: "azure-openai", model: modelId },
		{ reasoningEffort: effort, maxOutputTokens: 32_000 },
	);
	await streamText({
		model,
		messages: prompt,
		...settings.turnConfig,
		maxRetries: 0,
	}).text;
	const request = observed.at(-1)!;
	assert.equal(request.body.reasoning.effort, effort);
	assert.equal(request.body.max_output_tokens, 32_000);
	assert.equal(request.headers.has("api-key"), false);
	assert.ok(request.headers.has("cf-aig-authorization"));
	assert.match(
		request.url,
		/^https:\/\/workers-binding\.ai\/ai-gateway\/gateways\/test-gateway\/azure-openai\/test-resource\/openai\/v1\/responses$/,
	);
	assert.deepEqual(wire, {
		api: "responses",
		reasoningEffort: effort,
		maxOutputTokens: 32_000,
		store: false,
		encryptedReasoningIncluded: true,
		chatStreamOptionsPresent: false,
		promptCacheKeyPresent: false,
		promptCacheMode: null,
		promptCacheBreakpointCount: 0,
		providerAppliedDefaults: "unobserved",
	});
}
assert.equal(authorizations.length, efforts.length);
assert.ok(
	JSON.stringify(authorizations).includes('"estimatedOutputTokens":32000'),
	"admission sees the real output allowance",
);

await generateText({
	model,
	system: [
		{
			role: "system",
			content: "stable persona",
			providerOptions: {
				azure: { promptCacheBreakpoint: { mode: "explicit" } },
			},
		},
		{ role: "system", content: "dynamic tools" },
	],
	messages: prompt,
	maxRetries: 0,
	maxOutputTokens: 32_000,
	providerOptions: {
		azure: {
			reasoningEffort: "medium",
			promptCacheKey: "tedix-pc-v1-opaque",
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
		},
	},
});
assertModelRequestSettings(wire, {
	maxOutputTokens: 32_000,
	reasoningEffort: "medium",
	promptCache: true,
});
assert.equal(observed.at(-1)!.body.prompt_cache_key, "tedix-pc-v1-opaque");
assert.deepEqual(observed.at(-1)!.body.prompt_cache_options, {
	mode: "explicit",
	ttl: "30m",
});
assert.match(
	JSON.stringify(observed.at(-1)!.body.input),
	/"prompt_cache_breakpoint":\{"mode":"explicit"\}/,
);
const count = observed.length;
await assert.rejects(
	generateText({
		model: azureModel(
			{ ...env, API_SERVICE: undefined },
			{ orgId: "test-org" },
		).responses(modelId),
		messages: prompt,
		maxRetries: 0,
	}),
	/billing binding/,
);
assert.equal(observed.length, count, "no provider request before admission");
const admittedCount = authorizations.length;
await assert.rejects(
	generateText({
		model: azureModel(env, { orgId: "test-org", source: "ci" }, (request) =>
			assertModelRequestSettings(request, {
				maxOutputTokens: 32_000,
				reasoningEffort: "high",
			}),
		).responses(modelId),
		messages: prompt,
		maxOutputTokens: 32_000,
		providerOptions: { azure: { reasoningEffort: "low" } },
		maxRetries: 0,
	}),
	/did not serialize/,
);
assert.equal(
	authorizations.length,
	admittedCount,
	"option loss rejected before billing",
);
assert.equal(
	observed.length,
	count,
	"option loss rejected before provider execution",
);

const schemaSpoof = modelRequestTelemetry(
	"https://example.com/openai/v1/responses",
	JSON.stringify({
		store: false,
		include: ["reasoning.encrypted_content"],
		max_output_tokens: 100,
		prompt_cache_key: "opaque",
		prompt_cache_options: { mode: "explicit" },
		input: [{ role: "developer", content: "stable but unmarked" }],
		tools: [
			{
				type: "function",
				name: "spoof",
				parameters: {
					type: "object",
					properties: { prompt_cache_breakpoint: { type: "string" } },
				},
			},
		],
	}),
);
assert.equal(schemaSpoof?.promptCacheBreakpointCount, 0);
assert.throws(
	() =>
		assertModelRequestSettings(schemaSpoof, {
			maxOutputTokens: 100,
			reasoningEffort: null,
			promptCache: true,
		}),
	/cache boundary/,
);

const malformedInstructionBreakpoint = modelRequestTelemetry(
	"https://example.com/openai/v1/responses",
	JSON.stringify({
		store: false,
		include: ["reasoning.encrypted_content"],
		max_output_tokens: 100,
		prompt_cache_key: "opaque",
		prompt_cache_options: { mode: "explicit" },
		input: [
			{
				role: "developer",
				content: [
					{
						type: "input_text",
						text: "stable but incorrectly marked",
						prompt_cache_breakpoint: { mode: "implicit" },
					},
				],
			},
		],
	}),
);
assert.equal(malformedInstructionBreakpoint?.promptCacheBreakpointCount, 0);
assert.throws(
	() =>
		assertModelRequestSettings(malformedInstructionBreakpoint, {
			maxOutputTokens: 100,
			reasoningEffort: null,
			promptCache: true,
		}),
	/cache boundary/,
);

assert.equal(
	modelRequestTelemetry("https://example.com/chat/completions", "bad json"),
	null,
);
const secret = "private-input-that-must-never-enter-telemetry";
assert.ok(
	!JSON.stringify(
		modelRequestTelemetry(
			"https://example.com/chat/completions",
			JSON.stringify({
				messages: secret,
				reasoning_effort: secret,
				max_completion_tokens: 32_000,
			}),
		),
	).includes(secret),
);

// Local Responses experiment only. This captures the real SDK protocol; it
// does not claim the deployed Azure/Gateway route supports Responses.
let responsesBody: Record<string, any> = {};
const responses = createAzure({
	resourceName: "test-resource",
	apiKey: "test-only",
	fetch: async (_url, init) => {
		responsesBody = JSON.parse(String(init?.body));
		return Response.json({
			id: "resp-test",
			object: "response",
			created_at: 1,
			model: modelId,
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg-test",
					role: "assistant",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		});
	},
}).responses(modelId);
const history: UIMessage[] = [
	{
		id: "user",
		role: "user",
		parts: [{ type: "text", text: "inspect the code" }],
	},
	{
		id: "assistant",
		role: "assistant",
		parts: [
			{
				type: "reasoning",
				text: "",
				providerMetadata: {
					azure: { reasoningEncryptedContent: "opaque-reasoning-state" },
				},
			},
			{
				type: "dynamic-tool",
				toolName: "read_code",
				toolCallId: "call-test",
				state: "output-available",
				input: { path: "file.ts" },
				output: { text: "export const value = 1;" },
			},
		],
	},
	{ id: "next", role: "user", parts: [{ type: "text", text: "continue" }] },
];
const restoredPrompt = await convertToModelMessages(
	JSON.parse(JSON.stringify(history)),
);
await generateText({
	model: responses,
	messages: restoredPrompt,
	maxRetries: 0,
	maxOutputTokens: 32_000,
	providerOptions: {
		azure: {
			reasoningEffort: "high",
			store: false,
			include: ["reasoning.encrypted_content"],
		},
	},
});
assert.equal(responsesBody.reasoning.effort, "high");
assert.equal(responsesBody.max_output_tokens, 32_000);
assert.equal(responsesBody.store, false);
assert.ok(responsesBody.include.includes("reasoning.encrypted_content"));
assert.ok(
	responsesBody.input.some(
		(part: Record<string, any>) =>
			part.type === "reasoning" &&
			part.encrypted_content === "opaque-reasoning-state",
	),
);
assert.ok(
	responsesBody.input.some(
		(part: Record<string, any>) =>
			part.type === "function_call" && part.call_id === "call-test",
	),
);
assert.ok(
	responsesBody.input.some(
		(part: Record<string, any>) =>
			part.type === "function_call_output" && part.call_id === "call-test",
	),
);
console.log(
	"Real SDK: Responses streaming/effort/cap/admission/telemetry and encrypted replay pass",
);

const beforeInvalid = {
	sends: observed.length,
	admissions: authorizations.length,
};
await assert.rejects(
	generateText({
		model,
		messages: prompt,
		maxRetries: 0,
		providerOptions: { azure: { store: true } },
	}),
	/stateless Responses/,
);
for (const patch of [
	{ api: "chat" },
	{ store: true },
	{ encryptedReasoningIncluded: false },
	{ chatStreamOptionsPresent: true },
]) {
	assert.throws(
		() =>
			assertModelRequestSettings(
				{ ...wire!, ...patch },
				{ reasoningEffort: "max", maxOutputTokens: 32000 },
			),
		/stateless Responses/,
	);
}
assert.deepEqual(
	{ sends: observed.length, admissions: authorizations.length },
	beforeInvalid,
);
// Actual adapter sends preserve attribution and terminate on cancellation/failure.
const admission = authorizations[0]!.json;
assert.equal(admission.execution.provider, "azure-openai");
assert.equal(admission.execution.requestModel, modelId);
assert.equal(admission.organizationId, "00000000-0000-4000-8000-000000000001");
assert.equal(admission.estimatedOutputTokens, 32_000);
assert.equal(
	JSON.parse(observed[0]!.headers.get("cf-aig-metadata")!).orgId,
	admission.organizationId,
);

for (const kind of ["caller", "deadline"] as const) {
	let sends = 0;
	let sentSignal: AbortSignal | null = null;
	const caller = new AbortController();
	const transport = {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			sentSignal = new Request(input, init).signal;
			if (kind === "caller")
				setTimeout(() => caller.abort(new Error("fixture caller canceled")), 1);
			return new Promise<Response>((_resolve, reject) => {
				const signal = sentSignal!;
				if (signal.aborted) reject(signal.reason);
				else
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
			});
		},
	};
	await assert.rejects(
		generateText({
			model: azureModel(
				{
					...env,
					AI: transport,
					TEDI_AI_REQUEST_TIMEOUT_MS: "5000",
				} as unknown as AzureChatEnv,
				{ orgId: "test-org", source: "ci" },
			).responses(modelId),
			messages: prompt,
			abortSignal: caller.signal,
			maxRetries: 0,
		}),
		kind === "caller" ? /fixture caller canceled/ : /timeout|timed out/i,
	);
	assert.equal(sends, 1);
	assert.ok((sentSignal as AbortSignal | null)?.aborted);
}
let failedSends = 0;
await assert.rejects(
	generateText({
		model: azureModel(
			{
				...env,
				AI: {
					fetch: async () => {
						failedSends++;
						return Response.json(
							{
								error: {
									message: "fixture provider unavailable",
									type: "server_error",
								},
							},
							{ status: 503 },
						);
					},
				},
			} as unknown as AzureChatEnv,
			{ orgId: "test-org", source: "ci" },
		).responses(modelId),
		messages: prompt,
		maxRetries: 0,
	}),
	/fixture provider unavailable/,
);
assert.equal(failedSends, 1, "no second transport after provider failure");
const beforeDenied = observed.length;
await assert.rejects(
	generateText({
		model: azureModel(
			{
				...env,
				API_SERVICE: {
					fetch: async () =>
						Response.json({
							json: {
								allowed: false,
								code: "payment_required",
								entitlement: null,
								settlementMode: "disabled",
								attributionVersion: 3,
								executionId: crypto.randomUUID(),
								sendBefore: "2099-01-01T00:00:00.000Z",
								reservationId: null,
								expiresAt: null,
								estimatedChargeMicros: null,
							},
						}),
				},
			} as unknown as AzureChatEnv,
			{ orgId: "test-org", source: "ci" },
		).responses(modelId),
		messages: prompt,
		maxRetries: 0,
	}),
	/blocked by billing policy/,
);
assert.equal(
	observed.length,
	beforeDenied,
	"denied admission never sends a provider request",
);
console.log(
	"Responses transport abort/deadline/failure/admission and model attribution pass",
);

// Actual native approval tool, including the persisted descriptor reconstruction
// used by the facet. This captures SDK wire bytes, not provider normalization.
const inboxCalls: unknown[] = [];
const inbox = createWorkApprovalAiTools(
	async () =>
		({
			listWorkApprovalInbox: async (input: unknown) => {
				inboxCalls.push(input);
				return { items: [] };
			},
		}) as unknown as PlatformClient,
).list_work_approval_inbox!;
const [inboxDescriptor] = describeFacetTools({
	list_work_approval_inbox: inbox,
});
assert.ok(inboxDescriptor);
const originalInboxSchema = structuredClone(inboxDescriptor.inputSchema);
const rebuiltInbox = dynamicTool({
	description: inboxDescriptor.description,
	inputSchema: jsonSchema(inboxDescriptor.inputSchema),
	execute: async () => {
		throw new Error("schema-only facet capture must not execute");
	},
});
for (const definition of [inbox, rebuiltInbox]) {
	for (const streaming of [false, true]) {
		const options = {
			model,
			messages: prompt,
			tools: { list_work_approval_inbox: definition },
			maxRetries: 0,
		};
		if (streaming) await streamText(options).text;
		else await generateText(options);
		const sent = observed.at(-1)!.body.tools[0];
		assert.equal(
			sent.strict,
			false,
			"unspecified native function strictness must be explicit",
		);
		assert.deepEqual(
			sent.parameters.properties,
			originalInboxSchema.properties,
		);
		assert.deepEqual(
			sent.parameters.required ?? [],
			originalInboxSchema.required ?? [],
		);
		assert.equal(sent.parameters.properties.cursor.type, "object");
		assert.deepEqual(sent.parameters.properties.cursor.required, ["at", "id"]);
		assert.equal(sent.parameters.properties.limit.type, "integer");
	}
}
assert.deepEqual(
	describeFacetTools({ list_work_approval_inbox: inbox })[0]!.inputSchema,
	originalInboxSchema,
	"outbound transforms must not mutate reusable schemas",
);
assert.equal(inboxCalls.length, 0);

// Real SDK parsing/execution validates direct native Zod tools before effects.
// Faceted jsonSchema descriptors have no local Zod validator; no claim is made
// that this exercises that separate path's authoritative RPC validation.
const proposalId = "00000000-0000-4000-8000-000000000002";
const cursor = {
	at: "2026-09-20T00:00:00.000Z",
	id: "00000000-0000-4000-8000-000000000003",
};
for (const args of [
	{ proposalId, limit: 10 },
	{ proposalId, cursor },
	{ proposalId, cursor: null },
	{ proposalId, cursor: "__OMIT__" },
	{ proposalId, limit: 0 },
]) {
	const prior: number = inboxCalls.length;
	const toolModel = azureModel(
		{
			...env,
			AI: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = (await new Request(input, init).json()) as Record<
						string,
						any
					>;
					assert.equal(body.tools[0].strict, false);
					return Response.json({
						id: "resp-inbox",
						object: "response",
						created_at: 1,
						model: modelId,
						status: "completed",
						output: [
							{
								type: "function_call",
								id: "fc-inbox",
								call_id: "call-inbox",
								name: "list_work_approval_inbox",
								arguments: JSON.stringify(args),
								status: "completed",
							},
						],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					});
				},
			},
		} as unknown as AzureChatEnv,
		{ orgId: "test-org", source: "ci" },
	).responses(modelId);
	const result = await generateText({
		model: toolModel,
		messages: prompt,
		tools: { list_work_approval_inbox: inbox },
		maxRetries: 0,
	});
	const valid =
		args.cursor !== null && args.cursor !== "__OMIT__" && args.limit !== 0;
	assert.equal(inboxCalls.length, prior + (valid ? 1 : 0));
	if (valid) {
		assert.deepEqual(inboxCalls.at(-1), args);
		assert.equal(result.toolResults.length, 1);
	} else
		assert.equal(
			result.toolResults.length,
			0,
			"invalid direct native args never execute the tool",
		);
}
console.log(
	"Native inbox and rebuilt descriptor omission policy; direct SDK validation before effects pass",
);

// The observed nested sentinel is a different case: the native cursor's `at`
// only requires nonempty text. The canonical RPC schema supplies the ISO check.
assert.equal(
	ListWorkApprovalInboxInputSchema.safeParse({
		proposalId,
		cursor: { ...cursor, at: "__OMIT__" },
	}).success,
	false,
);
assert.equal(
	ListWorkApprovalInboxInputSchema.safeParse({ proposalId, cursor }).success,
	true,
);

// Each actual SDK retry is a new dispatch with its own immutable receipt.
const retryMetadata: Record<string, unknown>[] = [];
const retryAdmissionStart = authorizations.length;
const retried = await generateText({
	model: azureModel(
		{
			...env,
			AI: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = new Request(input, init);
					retryMetadata.push(
						JSON.parse(request.headers.get("cf-aig-metadata")!),
					);
					if (retryMetadata.length === 1)
						return Response.json(
							{ error: { message: "retry fixture", type: "server_error" } },
							{ status: 503 },
						);
					return (env.AI as unknown as { fetch: typeof fetch }).fetch(
						input,
						init,
					);
				},
			},
		} as unknown as AzureChatEnv,
		{ orgId: "test-org", source: "ci" },
	).responses(modelId),
	messages: prompt,
	maxRetries: 1,
});
assert.equal(retried.text, "ok");
assert.equal(retryMetadata.length, 2);
const retryEnvelopes = retryMetadata.map((metadata) =>
	JSON.parse(metadata.attribution as string),
);
assert.ok(
	retryEnvelopes.every((entry) => entry.v === 3 && typeof entry.e === "string"),
);
assert.notEqual(retryEnvelopes[0].e, retryEnvelopes[1].e);
const retryAdmissions = authorizations.slice(retryAdmissionStart);
assert.equal(retryAdmissions.length, 2);
assert.notEqual(
	retryAdmissions[0]!.json.idempotencyKey,
	retryAdmissions[1]!.json.idempotencyKey,
);
assert.deepEqual(
	retryAdmissions[0]!.json.execution,
	retryAdmissions[1]!.json.execution,
);
console.log(
	"Native SDK retries mint distinct execution receipts before each provider dispatch",
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

function azureModel(...args: Parameters<typeof nativeAzureModel>) {
	const [environment, metadata, inspect, guard] = args;
	return nativeAzureModel(
		environment,
		{ ...metadata, tediId: "fixture-tedi" },
		inspect,
		guard ?? fixtureOriginGuard(metadata?.orgId ?? "org"),
	);
}
