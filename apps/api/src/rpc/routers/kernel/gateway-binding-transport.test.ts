import { generateObject } from "ai";
import { z } from "zod";
import { planKernelRoute } from "./route-planner";
/**
 * End-to-end proof that kernel AI Gateway traffic rides the Workers AI binding
 * when `AI_GATEWAY_BINDING_PROVIDERS` says the gateway is in-account, and stays
 * on public HTTPS + `CF_AI_GATEWAY_TOKEN` when it does not.
 */
import { describe, expect, it, vi } from "vite-plus/test";

// Billing reservation needs D1 and is proven by its own suite; this one is about
// which wire the request leaves on.
vi.mock("./billing-reservation", async (original) => ({
	...(await original<typeof import("./billing-reservation")>()),
	reserveKernelBilling: async (
		_env: unknown,
		input: {
			context?: import("./gateway-attribution").KernelGatewayContext;
			execution: import("@tedix/api-contract/schemas/provider-execution").ProviderExecutionIdentity;
		},
	) => {
		const executionId = crypto.randomUUID();
		input.context?.executionAttempts?.push({
			identity: input.execution,
			executionId,
			occurredAt: new Date().toISOString(),
		});
		return { ...input.context, executionId };
	},
}));

import {
	callWorkersAi,
	usingWorkersAiGateway,
	type WorkersAiTransportEnv,
} from "@tedix/workers-ai/transport";
import { kernelModel, kernelGatewayFetch, type KernelEnv } from "./llm";
import { kernelWorkersAiClient } from "./workers-ai-client";

function chatResponse(): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: "ok" } }],
			usage: { prompt_tokens: 3, completion_tokens: 4 },
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

function bindingEnv(extra: Partial<WorkersAiTransportEnv> = {}) {
	const bindingFetch = vi.fn(async () => chatResponse());
	const env: WorkersAiTransportEnv = {
		AI: { fetch: bindingFetch, run: vi.fn() } as unknown as Ai,
		AI_GATEWAY_ACCOUNT_ID: "acct123",
		AI_GATEWAY_LLM_ID: "tedix-llm-production",
		AI_GATEWAY_BINDING_PROVIDERS: "workers-ai,azure-openai",
		...extra,
	};
	return { env, bindingFetch };
}

describe("Workers AI over the AI Gateway binding transport", () => {
	it("is configured with no token at all", () => {
		const { env } = bindingEnv();
		expect(env.CF_AI_GATEWAY_TOKEN).toBeUndefined();
		expect(env.CF_WORKERS_AI_TOKEN).toBeUndefined();
		expect(usingWorkersAiGateway(env)).toBe(true);
	});

	it("calls the binding fetch on the binding host with the body untouched", async () => {
		const { env, bindingFetch } = bindingEnv();
		const messages = [{ role: "user", content: "hello" }];
		const result = await callWorkersAi(
			kernelWorkersAiClient(env, { organizationId: "org_1" }),
			"@cf/openai/gpt-oss-120b",
			{ messages },
		);
		expect(result.text).toBe("ok");
		expect(bindingFetch).toHaveBeenCalledTimes(1);
		const [url, init] = bindingFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/tedix-llm-production/workers-ai/v1/chat/completions",
		);
		// Provider-native passthrough: the chat body, not a universal-endpoint envelope.
		expect(JSON.parse(init.body as string)).toEqual({
			model: "@cf/openai/gpt-oss-120b",
			messages,
		});
		const headers = init.headers as Record<string, string>;
		expect(headers["cf-aig-authorization"]).toBe(
			"Bearer cloudflare-gateway-binding",
		);
		// No Workers-AI BYOK token on the binding path.
		expect(headers.Authorization).toBeUndefined();
	});

	it("keeps an out-of-account gateway on HTTPS with both tokens", async () => {
		const globalFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => chatResponse());
		try {
			const { env, bindingFetch } = bindingEnv({
				// workers-ai is deliberately absent: that gateway is not in-account.
				AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
				CF_AI_GATEWAY_TOKEN: "aig-token",
				CF_WORKERS_AI_TOKEN: "byok-token",
			});
			await callWorkersAi(
				kernelWorkersAiClient(env, { organizationId: "org_1" }),
				"@cf/openai/gpt-oss-120b",
				{ messages: [{ role: "user", content: "hello" }] },
			);
			expect(bindingFetch).not.toHaveBeenCalled();
			expect(globalFetch).toHaveBeenCalledTimes(1);
			const [url, init] = globalFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(
				"https://gateway.ai.cloudflare.com/v1/acct123/tedix-llm-production/workers-ai/v1/chat/completions",
			);
			const headers = init.headers as Record<string, string>;
			expect(headers["cf-aig-authorization"]).toBe("Bearer aig-token");
			expect(headers.Authorization).toBe("Bearer byok-token");
		} finally {
			globalFetch.mockRestore();
		}
	});

	it("falls back to env.AI.run when neither gateway transport is configured", async () => {
		const run = vi.fn(async () => ({ response: "from-binding-run" }));
		const env: WorkersAiTransportEnv = {
			AI: { run } as unknown as Ai,
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			AI_GATEWAY_LLM_ID: "tedix-llm-production",
		};
		expect(usingWorkersAiGateway(env)).toBe(false);
		const result = await callWorkersAi(
			kernelWorkersAiClient(env, { organizationId: "org_1" }),
			"@cf/openai/gpt-oss-120b",
			{ messages: [{ role: "user", content: "hi" }] },
		);
		expect(result.text).toBe("from-binding-run");
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("Azure Responses over the AI Gateway binding transport", () => {
	const AZURE_URL =
		"https://tedix-resource.openai.azure.com/openai/v1/responses";

	function azureEnv(extra: Partial<KernelEnv> = {}) {
		const bindingFetch = vi.fn(async () => new Response("{}"));
		const env = {
			AZURE_OPENAI_RESOURCE: "tedix-resource",
			AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			AI_GATEWAY_LLM_ID: "tedix-llm-production",
			AI: { fetch: bindingFetch } as unknown as Ai,
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai,azure-openai",
			...extra,
		} as unknown as KernelEnv;
		return { env, bindingFetch };
	}

	it("rewrites the SDK's Azure URL onto the binding host and sends it there", async () => {
		const { env, bindingFetch } = azureEnv();
		const send = kernelGatewayFetch(env, { organizationId: "org_1" });
		expect(send).toBeDefined();
		const body = JSON.stringify({
			model: "gpt-6-luna",
			input: [{ role: "user", content: "hi" }],
		});
		await send?.(AZURE_URL, { method: "POST", body });
		expect(bindingFetch).toHaveBeenCalledTimes(1);
		const [url, init] = bindingFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/tedix-llm-production/azure-openai/tedix-resource/openai/v1/responses",
		);
		expect(init.body).toBe(body);
		expect(new Headers(init.headers).get("cf-aig-authorization")).toBe(
			"Bearer cloudflare-gateway-binding",
		);
	});

	it("keeps azure-openai on HTTPS with its token when it is not allowlisted", async () => {
		const globalFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("{}"));
		try {
			const { env, bindingFetch } = azureEnv({
				AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
				CF_AI_GATEWAY_TOKEN: "aig-token",
			});
			await kernelGatewayFetch(env, { organizationId: "org_1" })?.(AZURE_URL, {
				method: "POST",
				body: JSON.stringify({ model: "gpt-6-luna", input: "hi" }),
			});
			expect(bindingFetch).not.toHaveBeenCalled();
			const [url, init] = globalFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(
				"https://gateway.ai.cloudflare.com/v1/acct123/tedix-llm-production/azure-openai/tedix-resource/openai/v1/responses",
			);
			expect(new Headers(init.headers).get("cf-aig-authorization")).toBe(
				"Bearer aig-token",
			);
		} finally {
			globalFetch.mockRestore();
		}
	});

	it("reserves and sends the replacement Request body with its exact deployment", async () => {
		const { env, bindingFetch } = azureEnv();
		const attempts: import("./gateway-attribution").KernelExecutionAttempt[] =
			[];
		const body = JSON.stringify({
			model: "gpt-6-luna",
			input: "hi",
			stream: true,
		});
		const request = new Request(AZURE_URL, {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.6-luna", input: "original" }),
		});
		await kernelGatewayFetch(env, {
			organizationId: "org_1",
			executionAttempts: attempts,
		})?.(request, { body });
		expect(attempts[0]?.identity.requestModel).toBe("gpt-6-luna");
		expect(bindingFetch.mock.calls[0]?.[1].body).toBe(body);
		expect(JSON.parse(body)).not.toHaveProperty("stream_options");
	});

	it("is unavailable when neither the allowlist nor a token is configured", () => {
		const { env } = azureEnv({ AI_GATEWAY_BINDING_PROVIDERS: "" });
		expect(kernelGatewayFetch(env)).toBeUndefined();
	});
});

describe("operation-scoped attempt observations", () => {
	it("retains Auto Router provider receipts on the admitted attempt", async () => {
		const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: '{"ok":true}' } }],
						usage: { prompt_tokens: 3, completion_tokens: 4 },
					}),
					{
						headers: {
							"content-type": "application/json",
							"cf-aig-routed-model": "openai/gpt-5.6-luna",
							"cf-aig-routing-reason": "quality_match",
							"cf-aig-routing-decision-id": "decision-1",
							"cf-aig-request-id": "request-1",
						},
					},
				),
		);
		try {
			const selected = kernelModel(
				{
					AZURE_OPENAI_RESOURCE: "resource",
					AZURE_CHAT_DEPLOYMENT: "deployment",
					AI_GATEWAY_ACCOUNT_ID: "acct123",
					AI_GATEWAY_LLM_ID: "tedix-llm-production",
					CF_AI_GATEWAY_TOKEN: "aig-token",
				} as KernelEnv,
				undefined,
				{ organizationId: "org", source: "kernel:conversation-title" },
			);
			if (!selected) throw new Error("Expected model");
			const operation = selected.forOperation();
			await generateObject({
				model: operation.model,
				schema: z.object({ ok: z.boolean() }),
				prompt: "one",
				maxRetries: 0,
			});
			expect(operation.attempts[0]?.autoRouter).toEqual({
				routedModel: "openai/gpt-5.6-luna",
				routingReason: "quality_match",
				routingDecisionId: "decision-1",
				requestId: "request-1",
			});
		} finally {
			globalFetch.mockRestore();
		}
	});

	function selected(responses: string[]) {
		let index = 0;
		const { env, bindingFetch } = bindingEnv();
		bindingFetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						id: "resp_test",
						object: "response",
						created_at: 1,
						model: "gpt-6-luna",
						status: "completed",
						output: [
							{
								type: "message",
								id: "msg",
								role: "assistant",
								content: [
									{
										type: "output_text",
										text: responses[index++] ?? "invalid",
										annotations: [],
									},
								],
							},
						],
						usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const model = kernelModel(
			{
				...env,
				AZURE_OPENAI_RESOURCE: "resource",
				AZURE_CHAT_DEPLOYMENT: "deployment",
			} as KernelEnv,
			{ modelRef: "azure-openai/gpt-5.6-luna" },
			{ organizationId: "org" },
		);
		if (!model) throw new Error("Expected model");
		return { model, env };
	}
	it("isolates sequential and concurrent operations sharing one selection", async () => {
		const { model } = selected(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
		const first = model.forOperation();
		await generateObject({
			model: first.model,
			schema: z.object({ ok: z.boolean() }),
			prompt: "one",
			maxRetries: 0,
		});
		const second = model.forOperation(),
			third = model.forOperation();
		await Promise.all(
			[second, third].map((operation) =>
				generateObject({
					model: operation.model,
					schema: z.object({ ok: z.boolean() }),
					prompt: "next",
					maxRetries: 0,
				}),
			),
		);
		expect(model.attempts).toEqual([]);
		for (const operation of [first, second, third]) {
			expect(operation.attempts).toHaveLength(1);
			expect(operation.attempts[0]?.usage).toEqual({
				inputTokens: 3,
				outputTokens: 4,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
		}
		expect(
			new Set([first, second, third].map((op) => op.attempts[0]?.executionId))
				.size,
		).toBe(3);
	});
	it("retains provider usage before a structured response fails parsing", async () => {
		const { model } = selected(["invalid"]);
		const operation = model.forOperation();
		await expect(
			generateObject({
				model: operation.model,
				schema: z.object({ ok: z.boolean() }),
				prompt: "one",
				maxRetries: 0,
			}),
		).rejects.toThrow();
		expect(operation.attempts).toHaveLength(1);
		expect(operation.attempts[0]?.usage?.inputTokens).toBe(3);
	});
	it("emits all failed output observations even when no route survives", async () => {
		const { model, env } = selected(["invalid", "invalid", "invalid"]);
		const observed: import("./gateway-attribution").KernelExecutionAttempt[] =
			[];
		const pending = planKernelRoute({
			content: "hello",
			context: {
				tedis: [],
				apps: [],
				workflows: [],
				workItems: [],
				facts: [],
				rationale: [],
				speaker: null,
				history: [],
			},
			model,
			env: env as KernelEnv,
			organizationId: "org",
			onExecutionAttempts: (attempts) => observed.push(...attempts),
		});
		await expect(pending).rejects.toThrow();
		expect(observed.length).toBeGreaterThanOrEqual(1);
		expect(observed[0]?.usage?.inputTokens).toBe(3);
		expect(model.attempts).toEqual([]);
	});
});
