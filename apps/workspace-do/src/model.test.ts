import { afterEach, expect, spyOn, test } from "bun:test";
import { createAzureGatewayModel } from "./model";

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
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
