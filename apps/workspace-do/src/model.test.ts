import { afterEach, expect, spyOn, test } from "bun:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { modelCatalogEntry } from "@tedix/api-contract/test/model-catalog";
import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import type {
	AuthorizeRuntimeInferenceResponse,
	AuthorizeWorkspaceInferenceInput,
	ReleaseInferenceReservationInput,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type { InferenceAdmissionPort } from "./admission";
import {
	catalogWorkspaceModels,
	configuredWorkspaceModels,
	createAzureGatewayModel,
	createWorkspaceModel,
	defaultWorkspaceModelId,
	turnPricingIdentity,
	type WorkspaceModelEnv,
} from "./model";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

/** Admission that records each call and answers with `decide`. */
function admission(
	decide: (
		input: AuthorizeWorkspaceInferenceInput,
	) => AuthorizeRuntimeInferenceResponse = () => allowed(),
) {
	const authorized: AuthorizeWorkspaceInferenceInput[] = [];
	const released: ReleaseInferenceReservationInput[] = [];
	const port: InferenceAdmissionPort = {
		async authorize(input) {
			authorized.push(input);
			return decide(input);
		},
		async release(input) {
			released.push(input);
		},
	};
	return { port, authorized, released };
}

function allowed(
	extra: Partial<
		Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>
	> = {},
): AuthorizeRuntimeInferenceResponse {
	const later = new Date(Date.now() + 60_000).toISOString();
	return {
		allowed: true,
		settlementMode: "managed",
		attributionVersion: 3,
		executionId: EXECUTION_ID,
		sendBefore: later,
		reservationId: "reservation-1",
		expiresAt: later,
		estimatedCredits: 3,
		...extra,
	};
}

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
});

test.each(["azure", "workers"] as const)(
	"%s repairs tool arguments on every replay without mutating history",
	async (provider) => {
		const args = {
			nested: ["before\uD800after", "\uDC00", "😀", null, 42],
			["key\uD800"]: true,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			api:
				provider === "azure" ? "azure-openai-responses" : "openai-completions",
			provider:
				provider === "azure"
					? "azure-openai-responses"
					: "cloudflare-workers-ai",
			model: provider === "azure" ? "fixture-deployment" : fixtureModelId,
			content: [
				{ type: "toolCall", id: "call_fixture", name: "read", arguments: args },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const history: Context = {
			messages: [
				{ role: "user", content: "Read", timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_fixture",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		let requests = 0;
		spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const body = (await new Request(input, init).json()) as {
				input?: Array<{ type: string; arguments?: string }>;
				messages?: Array<{
					tool_calls?: Array<{ function: { arguments: string } }>;
				}>;
			};
			const serialized =
				provider === "azure"
					? body.input!.find((item) => item.type === "function_call")!
							.arguments!
					: body.messages!.find((item) => item.tool_calls)!.tool_calls![0]!
							.function.arguments;
			expect(JSON.parse(serialized)).toEqual({
				nested: ["before�after", "�", "😀", null, 42],
				"key�": true,
			});
			requests++;
			return provider === "workers"
				? completion()
				: new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } })}\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
		});
		const model = createWorkspaceModel(
			provider === "azure" ? configuredEnv : workersEnv,
			attribution,
			admission().port,
		);
		for (let turn = 0; turn < 2; turn++)
			expect((await model.stream(history).result()).stopReason).toBe("stop");
		expect(requests).toBe(2);
		expect(assistant.content[0]).toMatchObject({ arguments: args });
		expect(args.nested[0]).toBe("before\uD800after");
	},
);

test("Azure sends the screenshot as image input after image residency admission", async () => {
	const requests: Request[] = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		requests.push(new Request(input, init));
		return Response.json(
			{ error: { message: "fixture response" } },
			{ status: 400 },
		);
	});
	const admitted = admission();
	const model = createAzureGatewayModel(
		configuredEnv,
		attribution,
		admitted.port,
		undefined,
		true,
	);
	const data = "iVBORw0KGgo=".repeat(512);
	await model
		.stream({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look" },
						{ type: "image", mimeType: "image/png", data },
					],
					timestamp: 0,
				},
			],
		})
		.result();
	expect(admitted.authorized[0]?.residencyModality).toBe("image");
	expect(admitted.authorized[0]?.estimatedInputTokens).toBeLessThan(4_500);
	const body = (await requests[0]!.json()) as { input: unknown[] };
	expect(body.input).toContainEqual(
		expect.objectContaining({
			role: "user",
			content: expect.arrayContaining([
				expect.objectContaining({
					type: "input_image",
					image_url: `data:image/png;base64,${data}`,
				}),
			]),
		}),
	);
});

test.each(["v1", "2025-03-01-preview"])(
	"the real Azure SDK uses GA Responses and stored BYOK with SDK version %s",
	async (apiVersion) => {
		const requests: Request[] = [];
		const controller = new AbortController();
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				expect(request.signal).toBeInstanceOf(AbortSignal);
				expect(request.signal.aborted).toBe(false);
				return Response.json(
					{
						error: {
							message: "fixture response",
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
			},
		);
		const metadata = attribution;
		const admitted = admission();
		const model = createAzureGatewayModel(
			{
				AZURE_OPENAI_RESOURCE: "fixture-resource",
				AZURE_OPENAI_API_VERSION: apiVersion,
				AZURE_CHAT_DEPLOYMENT: "fixture-model",
				AI_GATEWAY_ACCOUNT_ID: "fixture-account",
				AI_GATEWAY_LLM_ID: "fixture-gateway",
				CF_AI_GATEWAY_TOKEN: "fixture-token",
			},
			metadata,
			admitted.port,
		);
		await model
			.stream(
				{
					messages: [
						{ role: "user", content: "What is 17 plus 25?", timestamp: 0 },
					],
				},
				{ signal: controller.signal },
			)
			.result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = requests[0]!;
		const url = new URL(request.url);
		expect(url.origin).toBe("https://gateway.ai.cloudflare.com");
		expect(url.search).toBe("");
		expect(url.pathname).toBe(
			"/v1/fixture-account/fixture-gateway/azure-openai/fixture-resource/openai/v1/responses",
		);
		expect(request.headers.has("api-key")).toBe(false);
		expect(request.headers.has("authorization")).toBe(false);
		expect(request.headers.get("cf-aig-authorization")).toBe(
			"Bearer fixture-token",
		);
		expect(request.headers.get("cf-aig-no-wholesale")).toBe("true");
		const gatewayMetadata = JSON.parse(request.headers.get("cf-aig-metadata")!);
		expect(gatewayMetadata).toMatchObject({
			surface: "workspace_object",
			workspaceId: metadata.workspaceId,
			orgId: metadata.organizationId,
		});
		expect(decodeAiGatewayAttribution(gatewayMetadata.attribution)).toEqual({
			runId: metadata.turnId,
			workItemId: "system:workspace_chat",
			executionId: EXECUTION_ID,
			billingReservationId: "reservation-1",
		});
		expect(admitted.authorized[0]?.execution).toMatchObject({
			provider: "azure-openai",
			apiKind: "azure-responses",
			requestModel: "fixture-model",
			providerResource: "fixture-resource",
		});
		// The provider refused the request, so its hold goes back at once.
		expect(admitted.released).toEqual([
			{
				organizationId: metadata.organizationId,
				reservationId: "reservation-1",
				reason: "provider_request_failed",
			},
		]);
		const body = (await request.json()) as { model: string; stream: boolean };
		expect(body.model).toBe("fixture-model");
		expect(body.stream).toBe(true);
	},
);

const configuredEnv = {
	AZURE_OPENAI_RESOURCE: "fixture-resource",
	AZURE_CHAT_DEPLOYMENT: "fixture-deployment",
	AI_GATEWAY_ACCOUNT_ID: "fixture-account",
	AI_GATEWAY_LLM_ID: "fixture-gateway",
	CF_AI_GATEWAY_TOKEN: "fixture-token",
};

test("the model catalog exposes only a fully configured supported deployment", async () => {
	const { configuredWorkspaceModels } = await import("./model");
	expect(configuredWorkspaceModels({})).toEqual([]);
	expect(
		configuredWorkspaceModels({
			...configuredEnv,
			CF_AI_GATEWAY_TOKEN: "configured-via-private-overlay",
		}),
	).toEqual([]);
	expect(configuredWorkspaceModels(configuredEnv)).toEqual([
		{
			id: "azure-openai/fixture-deployment",
			label: "Azure deployment: fixture-deployment",
		},
	]);
});

test.each([true, false])(
	"provider model and usage receipts survive the real SDK (usage=%s)",
	async (hasUsage) => {
		spyOn(globalThis, "fetch").mockImplementation(async () => {
			const event = {
				type: "response.completed",
				response: {
					id: "fixture-response",
					status: "completed",
					model: "fixture-provider-snapshot",
					output: [],
					...(hasUsage
						? {
								usage: {
									input_tokens: 120,
									output_tokens: 15,
									total_tokens: 135,
									input_tokens_details: { cached_tokens: 40 },
								},
							}
						: {}),
				},
			};
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		});
		const model = createAzureGatewayModel(
			configuredEnv,
			attribution,
			admission().port,
		);
		const message = await model
			.stream({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] })
			.result();
		expect(message.stopReason).toBe("stop");
		expect(model.responseMetadata?.()).toEqual({
			model: "fixture-provider-snapshot",
			usageReported: hasUsage,
		});
		if (hasUsage) {
			expect(message.usage.input).toBe(80);
			expect(message.usage.cacheRead).toBe(40);
			expect(message.usage.output).toBe(15);
		}
	},
);

const fixtureModelId = "@cf/fixture/model-one";
const workersEnv = {
	AI_GATEWAY_ACCOUNT_ID: "fixture-account",
	AI_GATEWAY_LLM_ID: "fixture-gateway",
	CF_AI_GATEWAY_TOKEN: "fixture-token",
	AI_GATEWAY_AUTO_ALLOWED_MODELS: fixtureModelId,
};
const attribution = {
	organizationId: "fixture-org",
	workspaceId: "fixture-workspace",
	turnId: "fixture-turn",
	userId: "fixture-user",
};
const context = {
	systemPrompt: "Answer the question",
	messages: [{ role: "user" as const, content: "17 plus 25?", timestamp: 0 }],
};

function completion(usage?: unknown, inChoice = false) {
	const chunk = {
		id: "fixture-completion",
		object: "chat.completion.chunk",
		created: 0,
		model: "fixture-provider-snapshot",
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: "42" },
				finish_reason: "stop",
				...(inChoice && usage !== undefined ? { usage } : {}),
			},
		],
		...(!inChoice && usage !== undefined ? { usage } : {}),
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

test("Workers AI selection requires both explicit exact models and an executable transport", () => {
	expect(
		configuredWorkspaceModels({
			AI_GATEWAY_AUTO_ALLOWED_MODELS: fixtureModelId,
		}),
	).toEqual([]);
	expect(
		configuredWorkspaceModels({
			...workersEnv,
			AI_GATEWAY_LLM_ID: "configured-via-private-overlay",
		}),
	).toEqual([]);
	expect(
		configuredWorkspaceModels({
			...workersEnv,
			CF_AI_GATEWAY_TOKEN: "configured-via-private-overlay",
		}),
	).toEqual([]);
	expect(
		configuredWorkspaceModels({
			...workersEnv,
			AI_GATEWAY_AUTO_ALLOWED_MODELS: undefined,
		}),
	).toEqual([]);
	expect(
		configuredWorkspaceModels({
			...workersEnv,
			AI_GATEWAY_AUTO_ALLOWED_MODELS: ` ${fixtureModelId},@cf/fixture/model-two,${fixtureModelId} `,
		}),
	).toEqual([
		{ id: fixtureModelId, label: `Workers AI: ${fixtureModelId}` },
		{ id: "@cf/fixture/model-two", label: "Workers AI: @cf/fixture/model-two" },
	]);
	expect(
		createWorkspaceModel(workersEnv, attribution, admission().port).id,
	).toBe(fixtureModelId);
	expect(
		createWorkspaceModel(
			{ ...configuredEnv, ...workersEnv },
			attribution,
			admission().port,
		).id,
	).toBe("azure-openai/fixture-deployment");
	expect(
		createWorkspaceModel(
			{ ...configuredEnv, ...workersEnv },
			attribution,
			admission().port,
			fixtureModelId,
		).id,
	).toBe(fixtureModelId);
	expect(() => createWorkspaceModel({}, attribution, admission().port)).toThrow(
		"No model is configured",
	);
	for (const modelId of [
		"@cf/fixture/not-allowed",
		"azure-openai/not-configured",
		"",
		"auto",
	])
		expect(() =>
			createWorkspaceModel(workersEnv, attribution, admission().port, modelId),
		).toThrow("not configured");
});

test.each([
	"@cf/fixture/model-one,",
	"@cf/fixture/model-one,,@cf/fixture/model-two",
	"@cf/fixture/*",
	"@cf/fixture/model-one\n",
	"@cf/fixture/model-one?token=fixture",
	"https://example.test/model",
	"@cf/fixture/../model",
	"@cf//model",
	"@cf/fixture/model one",
])("rejects malformed deployment model policies: %s", (raw) => {
	expect(() =>
		configuredWorkspaceModels({
			...workersEnv,
			AI_GATEWAY_AUTO_ALLOWED_MODELS: raw,
		}),
	).toThrow("allowlist");
});

test("local direct workspace chat admits once and preserves native tool calls", async () => {
	const admitted = admission();
	let calls = 0;
	const run = async (model: string, input: unknown, options: unknown) => {
		calls++;
		expect(admitted.authorized).toHaveLength(calls);
		expect(model).toBe(fixtureModelId);
		expect(input).toMatchObject({ stream: false, max_tokens: 99 });
		expect(options).toBeUndefined();
		if (calls === 2) throw new Error("provider connection closed");
		return {
			choices: [
				{
					message: {
						content: "42",
						tool_calls: [
							{
								id: "provider-tool",
								function: { name: "lookup", arguments: '{"number":42}' },
							},
						],
					},
				},
			],
			usage: { prompt_tokens: 17, completion_tokens: 5 },
		};
	};
	const env = {
		...workersEnv,
		AI: { run } as unknown as WorkspaceModelEnv["AI"],
		AI_GATEWAY_LLM_ID: "",
		TEDIX_LOCAL_WORKERS_AI_ROUTE: "direct",
		ENVIRONMENT: "development",
	};
	expect(
		configuredWorkspaceModels({ ...env, ENVIRONMENT: "production" }),
	).toEqual([]);
	const model = createWorkspaceModel(env, attribution, admitted.port);
	const result = await model.stream(context, { maxTokens: 99 }).result();
	expect(result.stopReason).toBe("toolUse");
	expect(result.content).toContainEqual({
		type: "toolCall",
		id: expect.stringMatching(/^call_/),
		name: "lookup",
		arguments: { number: 42 },
	});
	expect(admitted.authorized[0]?.execution).toMatchObject({
		gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID,
		gatewayId: null,
		transportKind: "workers-ai-binding",
	});
	expect(model.responseMetadata?.().usageReported).toBe(true);
	expect(
		(await model.stream(context, { maxTokens: 99 }).result()).stopReason,
	).toBe("error");
	expect(calls).toBe(2);
	expect(admitted.authorized).toHaveLength(2);
});

test("Workers AI receives string content for text parts and tool-call turns", async () => {
	const sent: Array<{ role: string; content: unknown }>[] = [];
	const network = spyOn(globalThis, "fetch").mockImplementation(
		async (input, init) => {
			const body = await new Request(input, init).json();
			sent.push(body.messages);
			return completion();
		},
	);
	const model = createWorkspaceModel(workersEnv, attribution, admission().port);
	const toolTurn: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
		],
		api: "openai-completions",
		provider: "cloudflare-workers-ai",
		model: fixtureModelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	await model
		.stream({
			systemPrompt: "Answer the question",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "17 plus 25?" },
						{ type: "text", text: "Use the tool." },
					],
					timestamp: 0,
				},
				toolTurn,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "42" }],
					isError: false,
					timestamp: 0,
				},
			],
		})
		.result();
	network.mockRestore();
	expect(sent[0]?.map((message) => message.content)).toEqual([
		"Answer the question",
		"17 plus 25?\nUse the tool.",
		"",
		"42",
	]);
});

test("local gateway failure never dispatches directly or retries the request", async () => {
	const admitted = admission();
	let gatewayCalls = 0;
	let directCalls = 0;
	const env = {
		...workersEnv,
		AI: {
			async fetch() {
				gatewayCalls++;
				return new Response("Gateway unavailable", { status: 503 });
			},
			async run() {
				directCalls++;
				throw new Error("unexpected direct invocation");
			},
		} as unknown as WorkspaceModelEnv["AI"],
		AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
		TEDIX_LOCAL_WORKERS_AI_ROUTE: "gateway",
		ENVIRONMENT: "development",
	};
	const model = createWorkspaceModel(env, attribution, admitted.port);
	expect((await model.stream(context).result()).stopReason).toBe("error");
	expect(gatewayCalls).toBe(1);
	expect(directCalls).toBe(0);
	expect(admitted.authorized).toHaveLength(1);
	expect(admitted.authorized[0]?.execution.gatewayId).toBe(
		env.AI_GATEWAY_LLM_ID,
	);
});

test.each(["https", "binding"] as const)(
	"real Completions SDK routes %s transport with gateway-only authentication",
	async (kind) => {
		const requests: Request[] = [];
		const send = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return completion({
				prompt_tokens: 120,
				completion_tokens: 15,
				cached_tokens: 40,
			});
		};
		const network = spyOn(globalThis, "fetch").mockImplementation(send);
		const env: WorkspaceModelEnv =
			kind === "binding"
				? {
						AI: { fetch: send } as unknown as NonNullable<
							WorkspaceModelEnv["AI"]
						>,
						AI_GATEWAY_ACCOUNT_ID: "fixture-account",
						AI_GATEWAY_LLM_ID: "fixture-gateway",
						AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
						AI_GATEWAY_AUTO_ALLOWED_MODELS: fixtureModelId,
					}
				: workersEnv;
		const controller = new AbortController();
		const admitted = admission();
		const model = createWorkspaceModel(
			env,
			attribution,
			admitted.port,
			fixtureModelId,
		);
		const message = await model
			.stream(context, { signal: controller.signal, maxTokens: 99 })
			.result();
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "42" }]);
		expect(message.usage.input).toBe(80);
		expect(message.usage.output).toBe(15);
		expect(message.usage.cacheRead).toBe(40);
		expect(model.responseMetadata?.()).toEqual({
			model: "fixture-provider-snapshot",
			usageReported: true,
		});
		expect(requests).toHaveLength(1);
		expect(network).toHaveBeenCalledTimes(kind === "binding" ? 0 : 1);
		const request = requests[0]!;
		expect(request.url).toBe(
			kind === "binding"
				? "https://workers-binding.ai/ai-gateway/gateways/fixture-gateway/workers-ai/v1/chat/completions"
				: "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/workers-ai/v1/chat/completions",
		);
		expect(request.headers.has("authorization")).toBe(false);
		expect(request.headers.has("api-key")).toBe(false);
		expect(request.headers.has("x-api-key")).toBe(false);
		expect(request.headers.get("cf-aig-authorization")).toBe(
			`Bearer ${kind === "binding" ? "cloudflare-gateway-binding" : "fixture-token"}`,
		);
		expect(request.headers.get("cf-aig-no-wholesale")).toBe("true");
		expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toMatchObject({
			surface: "workspace_object",
			workspaceId: attribution.workspaceId,
			orgId: attribution.organizationId,
		});
		expect(admitted.authorized).toHaveLength(1);
		expect(admitted.authorized[0]).toMatchObject({
			organizationId: attribution.organizationId,
			turnId: attribution.turnId,
			userId: attribution.userId,
			estimatedOutputTokens: 99,
			execution: {
				provider: "workers-ai",
				requestModel: fixtureModelId,
				transportKind: kind === "binding" ? "gateway-binding" : "gateway-https",
			},
		});
		expect(admitted.released).toEqual([]);
		expect(request.signal.aborted).toBe(false);
		const body = (await request.json()) as {
			model: string;
			stream: boolean;
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			store?: boolean;
			prompt_cache_retention?: string;
			stream_options?: { include_usage: boolean };
		};
		expect(body.model).toBe(fixtureModelId);
		expect(body.stream).toBe(true);
		expect(body.max_tokens ?? body.max_completion_tokens).toBe(99);
		expect(body.messages[0]?.role).toBe("system");
		expect(body.store).toBeUndefined();
		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.stream_options?.include_usage).toBe(true);
	},
);

test.each([
	[undefined, false, false],
	[{ prompt_tokens: 0, completion_tokens: 0 }, false, true],
	[{ prompt_tokens: 8, completion_tokens: 2 }, true, true],
	[{ prompt_tokens: 0, completion_tokens: 0 }, true, true],
	[{ prompt_tokens: -1, completion_tokens: 2 }, false, false],
	[{ prompt_tokens: 4 }, false, false],
	[{ prompt_tokens: "4", completion_tokens: 2 }, false, false],
] as const)(
	"preserves real usage presence for flat and choice usage (%j,choice=%s)",
	async (usage, inChoice, reported) => {
		spyOn(globalThis, "fetch").mockImplementation(async () =>
			completion(usage, inChoice),
		);
		const model = createWorkspaceModel(
			workersEnv,
			attribution,
			admission().port,
			fixtureModelId,
		);
		await model.stream(context).result();
		expect(model.responseMetadata?.()).toEqual({
			model: "fixture-provider-snapshot",
			usageReported: reported,
		});
		// A missing receipt on the next stream must not inherit the previous one.
		spyOn(globalThis, "fetch").mockImplementation(async () => completion());
		await model.stream(context).result();
		expect(model.responseMetadata?.().usageReported).toBe(false);
	},
);

test("the workspace chat offers the published catalog in its order and names", () => {
	const env = {
		...configuredEnv,
		...workersEnv,
		AI_GATEWAY_AUTO_ALLOWED_MODELS: `${fixtureModelId},@cf/fixture/model-two,@cf/fixture/model-three`,
	};
	expect(
		catalogWorkspaceModels(env, [
			modelCatalogEntry("workers-ai/@cf/fixture/model-two", {
				label: "Model Two",
			}),
			modelCatalogEntry("cloudflare/auto", { label: "Auto" }),
			modelCatalogEntry("azure-openai/fixture-deployment", {
				label: "Fixture Chat",
			}),
			modelCatalogEntry(`workers-ai/${fixtureModelId}`, {
				label: "Hidden One",
				hidden: true,
			}),
			modelCatalogEntry("workers-ai/@cf/fixture/model-three", {
				label: "Old Three",
				lifecycle: "superseded",
			}),
			modelCatalogEntry("workers-ai/@cf/fixture/not-allowed", {
				label: "Not runnable here",
			}),
		]),
	).toEqual([
		{ id: "@cf/fixture/model-two", label: "Model Two" },
		{ id: "azure-openai/fixture-deployment", label: "Fixture Chat" },
	]);
	expect(catalogWorkspaceModels(env, [])).toEqual([]);
});

test.each([true, false])(
	"Azure chat requests carry the admitted AI Gateway price (rate resolved=%s)",
	async (resolved) => {
		const requests: Request[] = [];
		spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			requests.push(new Request(input as RequestInfo, init));
			return Response.json({ error: { message: "stop" } }, { status: 400 });
		});
		const model = createAzureGatewayModel(
			configuredEnv,
			attribution,
			admission(() =>
				allowed(
					resolved
						? {
								providerRate: {
									rateVersionId: "rate-1",
									inputMicrousdPerMillion: 1_000_000,
									outputMicrousdPerMillion: 5_000_000,
									cacheReadMicrousdPerMillion: 50_000,
									cacheWriteMicrousdPerMillion: 1_250_000,
								},
							}
						: {},
				),
			).port,
		);
		await model
			.stream({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] })
			.result();
		expect(requests[0]!.headers.get("cf-aig-custom-cost")).toBe(
			resolved
				? '{"per_token_in":0.000001,"per_token_out":0.000005,"per_cache_read_token":0.00000005,"per_cache_write_token":0.00000025}'
				: null,
		);
	},
);

test.each([
	["monthly_credit_limit_reached", "This month's Tedix credits are used up"],
	[
		"tedi_monthly_credit_cap_reached",
		"This tedi reached the monthly credit cap",
	],
	["member_monthly_credit_cap_reached", "You reached the monthly credit cap"],
] as const)(
	"a refused call (%s) never reaches the provider and says why",
	async (code, reason) => {
		const network = spyOn(globalThis, "fetch").mockImplementation(async () =>
			completion(),
		);
		const admitted = admission(() => ({
			allowed: false,
			code,
			entitlement: null,
		}));
		const model = createWorkspaceModel(
			workersEnv,
			attribution,
			admitted.port,
			fixtureModelId,
		);
		const message = await model.stream(context).result();
		expect(message.stopReason).toBe("error");
		expect(network).not.toHaveBeenCalled();
		// The SDK may retry a failed fetch; the refusal is asked for only once.
		expect(admitted.authorized).toHaveLength(1);
		expect(admitted.released).toEqual([]);
		expect(model.admissionRefusal?.()).toContain(reason);
		expect(model.admissionRefusal?.()).toContain(`(${code})`);
		// The next stream asks again; an admitted call clears the refusal.
		const next = createWorkspaceModel(
			workersEnv,
			attribution,
			admission().port,
			fixtureModelId,
		);
		await next.stream(context).result();
		expect(next.admissionRefusal?.()).toBeNull();
	},
);

test("a turn with a picked tedi and no model named gets the configured chat default when it is offered", () => {
	const offered = [
		{ id: "@cf/fixture/model-two", label: "Model Two" },
		{ id: "azure-openai/gpt-6.1-sol", label: "Sol" },
	];
	expect(defaultWorkspaceModelId(offered, "azure-openai/gpt-6.1-sol")).toBe(
		"azure-openai/gpt-6.1-sol",
	);
	expect(
		defaultWorkspaceModelId(offered, "workers-ai/@cf/fixture/model-two"),
	).toBe("@cf/fixture/model-two");
	expect(defaultWorkspaceModelId(offered, "azure-openai/not-offered")).toBe(
		"@cf/fixture/model-two",
	);
	expect(defaultWorkspaceModelId(offered, undefined)).toBe(
		"@cf/fixture/model-two",
	);
});

test("a call that never reaches the provider releases its hold", async () => {
	spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new TypeError("network down");
	});
	const admitted = admission();
	const model = createWorkspaceModel(
		workersEnv,
		attribution,
		admitted.port,
		fixtureModelId,
	);
	const message = await model.stream(context).result();
	expect(message.stopReason).toBe("error");
	expect(model.admissionRefusal?.()).toBeNull();
	expect(admitted.released.length).toBeGreaterThan(0);
	expect(admitted.released[0]).toEqual({
		organizationId: attribution.organizationId,
		reservationId: "reservation-1",
		reason: "provider_request_not_sent",
	});
});

test("a guest tedi turn names the tedi to admission and the gateway", async () => {
	const requests: Request[] = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		requests.push(new Request(input as RequestInfo, init));
		return completion();
	});
	const admitted = admission();
	const call = { ...attribution, tediId: "fixture-tedi", userId: null };
	const model = createWorkspaceModel(
		workersEnv,
		call,
		admitted.port,
		fixtureModelId,
	);
	await model.stream(context).result();
	expect(admitted.authorized[0]).toMatchObject({
		tediId: "fixture-tedi",
		userId: null,
	});
	expect(
		JSON.parse(requests[0]!.headers.get("cf-aig-metadata")!),
	).toMatchObject({
		tediId: "fixture-tedi",
		orgId: attribution.organizationId,
	});
});

test("offers every Azure entry of the catalog and runs a tedi turn on the chat default's own deployment", async () => {
	const offered = catalogWorkspaceModels(configuredEnv, [
		modelCatalogEntry("azure-openai/fixture-deployment", { label: "First" }),
		modelCatalogEntry("azure-openai/fixture-second", { label: "Second" }),
	]);
	expect(offered).toEqual([
		{ id: "azure-openai/fixture-deployment", label: "First" },
		{ id: "azure-openai/fixture-second", label: "Second" },
	]);
	// A turn that names no model, answered by a picked tedi.
	const modelId = defaultWorkspaceModelId(
		offered,
		"azure-openai/fixture-second",
	);
	expect(modelId).toBe("azure-openai/fixture-second");

	const bodies: Array<{ model?: string }> = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		bodies.push(await new Request(input as RequestInfo, init).json());
		return new Response("data: {}\n\n", {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const admitted = admission();
	const model = createWorkspaceModel(
		configuredEnv,
		attribution,
		admitted.port,
		modelId,
	);
	expect(model.id).toBe("azure-openai/fixture-second");
	await model.stream(context).result();
	expect(bodies[0]?.model).toBe("fixture-second");
	expect(admitted.authorized[0]?.execution).toMatchObject({
		provider: "azure-openai",
		requestModel: "fixture-second",
	});
	expect(
		turnPricingIdentity(configuredEnv, "azure-openai/fixture-second"),
	).toMatchObject({ modelId: "fixture-second" });
});
