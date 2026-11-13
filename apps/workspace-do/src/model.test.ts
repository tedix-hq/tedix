import { afterEach, expect, spyOn, test } from "bun:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { modelCatalogEntry } from "@tedix/api-contract/test/model-catalog";
import {
	catalogWorkspaceModels,
	configuredWorkspaceModels,
	createAzureGatewayModel,
	createWorkspaceModel,
	type WorkspaceModelEnv,
} from "./model";

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
		);
		for (let turn = 0; turn < 2; turn++)
			expect((await model.stream(history).result()).stopReason).toBe("stop");
		expect(requests).toBe(2);
		expect(assistant.content[0]).toMatchObject({ arguments: args });
		expect(args.nested[0]).toBe("before\uD800after");
	},
);

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
		const metadata = {
			workspaceId: "fixture-workspace",
			turnId: "fixture-turn",
			actorId: "fixture-user",
		};
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
		expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
			surface: "workspace_object",
			...metadata,
		});
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
		const model = createAzureGatewayModel(configuredEnv, {
			workspaceId: "ws",
			turnId: "turn",
			actorId: "user",
		});
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
	workspaceId: "fixture-workspace",
	turnId: "fixture-turn",
	actorId: "fixture-user",
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
	expect(createWorkspaceModel(workersEnv, attribution).id).toBe(fixtureModelId);
	expect(
		createWorkspaceModel({ ...configuredEnv, ...workersEnv }, attribution).id,
	).toBe("azure-openai/fixture-deployment");
	expect(
		createWorkspaceModel(
			{ ...configuredEnv, ...workersEnv },
			attribution,
			fixtureModelId,
		).id,
	).toBe(fixtureModelId);
	expect(() => createWorkspaceModel({}, attribution)).toThrow(
		"No model is configured",
	);
	for (const modelId of [
		"@cf/fixture/not-allowed",
		"azure-openai/not-configured",
		"",
		"auto",
	])
		expect(() =>
			createWorkspaceModel(workersEnv, attribution, modelId),
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
						AI_GATEWAY_LLM_ID: "fixture-gateway",
						AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
						AI_GATEWAY_AUTO_ALLOWED_MODELS: fixtureModelId,
					}
				: workersEnv;
		const controller = new AbortController();
		const model = createWorkspaceModel(env, attribution, fixtureModelId);
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
		expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
			surface: "workspace_object",
			...attribution,
		});
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
		const model = createWorkspaceModel(workersEnv, attribution, fixtureModelId);
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
