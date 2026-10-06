import { describe, expect, it, vi } from "vite-plus/test";
import {
	AI_GATEWAY_BINDING_AUTH,
	callCloudflareAutoRouter,
	openCloudflareAutoRouterResponse,
	cloudflareAutoRouterCandidateHeaders,
	type AiGatewayTransportEnv,
	resolveAiGatewayTransport,
} from "./gateway-transport";

function fakeBinding(fetchImpl = vi.fn()): Ai {
	return { fetch: fetchImpl } as unknown as Ai;
}

const HTTPS_ENV: AiGatewayTransportEnv = {
	AI_GATEWAY_ACCOUNT_ID: "acct123",
	CF_AI_GATEWAY_TOKEN: "aig-token",
};

describe("resolveAiGatewayTransport", () => {
	it("routes an allowlisted provider over the binding host, with no account id", () => {
		const transport = resolveAiGatewayTransport(
			{
				...HTTPS_ENV,
				AI: fakeBinding(),
				AI_GATEWAY_BINDING_PROVIDERS: "workers-ai,azure-openai",
			},
			"example-gateway",
			"azure-openai",
		);
		expect(transport?.kind).toBe("binding");
		expect(transport?.providerRoot).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/example-gateway/azure-openai",
		);
		// The account id is what the binding channel replaces.
		expect(transport?.providerRoot).not.toContain("acct123");
	});

	it("sends binding requests through the binding's own fetch, untouched", async () => {
		const bindingFetch = vi.fn(async () => new Response("{}"));
		const transport = resolveAiGatewayTransport(
			{
				...HTTPS_ENV,
				AI: fakeBinding(bindingFetch),
				AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
			},
			"gw",
			"workers-ai",
		);
		const body = JSON.stringify({
			messages: [{ role: "user", content: "hi" }],
		});
		await transport?.fetch(`${transport.providerRoot}/v1/chat/completions`, {
			method: "POST",
			body,
		});
		expect(bindingFetch).toHaveBeenCalledTimes(1);
		const [url, init] = bindingFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/gw/workers-ai/v1/chat/completions",
		);
		// Passed straight through: the same string, not re-enveloped.
		expect(init.body).toBe(body);
	});

	it("authenticates a binding request with the pre-authenticated sentinel, never a token", () => {
		const transport = resolveAiGatewayTransport(
			{
				...HTTPS_ENV,
				AI: fakeBinding(),
				AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
			},
			"gw",
			"workers-ai",
		);
		expect(transport?.authorization).toBe(AI_GATEWAY_BINDING_AUTH);
		expect(transport?.authorization).not.toBe("aig-token");
	});

	it("keeps a provider that is NOT allowlisted on HTTPS with its token", () => {
		const transport = resolveAiGatewayTransport(
			{
				...HTTPS_ENV,
				AI: fakeBinding(),
				// azure-openai's gateway lives in another account → HTTPS only.
				AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
			},
			"gw",
			"azure-openai",
		);
		expect(transport?.kind).toBe("https");
		expect(transport?.providerRoot).toBe(
			"https://gateway.ai.cloudflare.com/v1/acct123/gw/azure-openai",
		);
		expect(transport?.authorization).toBe("aig-token");
		expect(transport?.fetch).not.toBe(undefined);
	});

	it("defaults to HTTPS when the allowlist is unset or blank", () => {
		for (const allowlist of [undefined, "", "  ", " , "]) {
			const transport = resolveAiGatewayTransport(
				{
					...HTTPS_ENV,
					AI: fakeBinding(),
					AI_GATEWAY_BINDING_PROVIDERS: allowlist,
				},
				"gw",
				"workers-ai",
			);
			expect(transport?.kind).toBe("https");
		}
	});

	it("still resolves the binding transport with no token configured at all", () => {
		const transport = resolveAiGatewayTransport(
			{ AI: fakeBinding(), AI_GATEWAY_BINDING_PROVIDERS: "workers-ai" },
			"gw",
			"workers-ai",
		);
		expect(transport?.kind).toBe("binding");
	});

	it("returns null when neither transport is configured", () => {
		expect(
			resolveAiGatewayTransport(
				{ AI_GATEWAY_ACCOUNT_ID: "acct123" },
				"gw",
				"workers-ai",
			),
		).toBeNull();
		// An allowlisted provider with no binding falls through to HTTPS, which
		// here has no token — so nothing is usable.
		expect(
			resolveAiGatewayTransport(
				{
					AI_GATEWAY_ACCOUNT_ID: "acct123",
					AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
				},
				"gw",
				"workers-ai",
			),
		).toBeNull();
		expect(resolveAiGatewayTransport(HTTPS_ENV, "  ", "workers-ai")).toBeNull();
	});
});

describe("callCloudflareAutoRouter", () => {
	it("restricts candidates from deployment config and preserves attribution", async () => {
		const fetchMock = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await callCloudflareAutoRouter(
				{
					...HTTPS_ENV,
					AI_GATEWAY_AUTO_ALLOWED_PROVIDERS: " workers-ai ",
					AI_GATEWAY_AUTO_ALLOWED_MODELS: "@cf/openai/gpt-oss-20b",
				},
				"gw",
				{ body: "{}", attribution: { orgId: "org-1" } },
			);
			const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
			expect(init.headers).toMatchObject({
				"cf-aig-allowed-providers": "workers-ai",
				"cf-aig-allowed-models": "@cf/openai/gpt-oss-20b",
				"cf-aig-authorization": "Bearer aig-token",
				"cf-aig-metadata": JSON.stringify({ orgId: "org-1" }),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects malformed candidate config before dispatch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			for (const raw of [
				"",
				"workers-ai,",
				"workers-ai\r\nx-other: unsafe",
				"workers ai",
			]) {
				await expect(
					callCloudflareAutoRouter(
						{
							...HTTPS_ENV,
							AI_GATEWAY_AUTO_ALLOWED_PROVIDERS: raw,
						},
						"gw",
						{ body: "{}" },
					),
				).rejects.toThrow(/Invalid deployment configuration/);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("uses the documented compat endpoint and preserves routing receipts", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
					{
						headers: {
							"cf-aig-routed-model": "openai/gpt-5.6-luna",
							"cf-aig-routing-reason": "cost_optimal_within_pool",
							"cf-aig-routing-decision-id": "decision-1",
						},
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await callCloudflareAutoRouter(HTTPS_ENV, "gw", {
				body: JSON.stringify({ model: "cloudflare/auto", messages: [] }),
				sessionId: "session-1",
				turnId: "turn-1",
			});
			expect(fetchMock).toHaveBeenCalledWith(
				"https://gateway.ai.cloudflare.com/v1/acct123/gw/compat/chat/completions",
				expect.objectContaining({ method: "POST" }),
			);
			const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
			expect(init.headers).toMatchObject({
				"cf-aig-session-id": "session-1",
				"cf-aig-turn-id": "turn-1",
			});
			expect(init.headers).not.toHaveProperty("cf-aig-allowed-providers");
			expect(init.headers).not.toHaveProperty("cf-aig-allowed-models");
			expect(result.routedModel).toBe("openai/gpt-5.6-luna");
			expect(result.routingDecisionId).toBe("decision-1");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fails closed without an authenticated gateway", async () => {
		await expect(
			callCloudflareAutoRouter({}, "gw", { body: "{}" }),
		).rejects.toThrow(/requires AI_GATEWAY_ACCOUNT_ID/);
	});
});

describe("Auto Router modality pools", () => {
	it("uses the deployment image pool and fails closed when it is missing", async () => {
		const fetchMock = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		const body = JSON.stringify({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AQID" },
						},
					],
				},
			],
		});
		try {
			await expect(
				callCloudflareAutoRouter(HTTPS_ENV, "gw", { body }),
			).rejects.toThrow(/image candidate pool/);
			expect(fetchMock).not.toHaveBeenCalled();
			await callCloudflareAutoRouter(
				{
					...HTTPS_ENV,
					AI_GATEWAY_AUTO_ALLOWED_MODELS: "text-model",
					AI_GATEWAY_AUTO_ALLOWED_IMAGE_MODELS: "vision-model",
				},
				"gw",
				{ body },
			);
			expect(
				(fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
			).toMatchObject({ "cf-aig-allowed-models": "vision-model" });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Auto Router request preflight", () => {
	it("normalizes only deployment-owned headers before dispatch", () => {
		expect(
			cloudflareAutoRouterCandidateHeaders(
				{
					AI_GATEWAY_AUTO_ALLOWED_PROVIDERS: " workers-ai ",
					AI_GATEWAY_AUTO_ALLOWED_MODELS: " @cf/openai/gpt-oss-20b ",
				},
				[{ content: "hi" }],
			),
		).toEqual({
			"cf-aig-allowed-providers": "workers-ai",
			"cf-aig-allowed-models": "@cf/openai/gpt-oss-20b",
		});
	});
	it("does not call fetch for an already aborted direct request", async () => {
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		try {
			await expect(
				openCloudflareAutoRouterResponse(HTTPS_ENV, "gw", {
					body: JSON.stringify({ messages: [] }),
					signal: AbortSignal.abort(),
				}),
			).rejects.toThrow();
			expect(send).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("last synchronous gateway boundary", () => {
	it.each(["https", "binding"] as const)(
		"%s rechecks the private guard for a caller retry on the same transport",
		async (route) => {
			const realFetch = globalThis.fetch;
			const send = vi.fn(async () => new Response("{}", { status: 503 }));
			globalThis.fetch = send;
			try {
				let active = true;
				const guard = vi.fn(() => {
					if (!active) throw new Error("revoked");
				});
				const transport = resolveAiGatewayTransport(
					{
						...HTTPS_ENV,
						...(route === "binding"
							? {
									AI: fakeBinding(send),
									AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
								}
							: {}),
					},
					"gw",
					"workers-ai",
					guard,
				)!;
				expect((await transport.fetch(transport.providerRoot)).status).toBe(
					503,
				);
				active = false;
				await expect(
					transport.fetch(transport.providerRoot),
				).rejects.toMatchObject({
					name: "ProviderDispatchGuardError",
					phase: "before_dispatch",
					providerRequestSent: false,
				});
				expect(send).toHaveBeenCalledTimes(1);
				expect(guard).toHaveBeenCalledTimes(2);
			} finally {
				globalThis.fetch = realFetch;
			}
		},
	);
	it.each(["open", "call"] as const)(
		"Auto %s uses its separate guard argument without serializing it",
		async (mode) => {
			const realFetch = globalThis.fetch;
			const send = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response("{}"),
			);
			globalThis.fetch = send;
			try {
				let active = true;
				const guard = vi.fn(() => {
					if (!active) throw new Error("held");
				});
				const call =
					mode === "open"
						? openCloudflareAutoRouterResponse
						: callCloudflareAutoRouter;
				await call(HTTPS_ENV, "gw", { body: '{"messages":[]}' }, guard);
				expect(send.mock.calls[0]?.[1]?.body).toBe('{"messages":[]}');
				expect(JSON.stringify(send.mock.calls[0]?.[1])).not.toContain(
					"beforeDispatch",
				);
				active = false;
				await expect(
					call(HTTPS_ENV, "gw", { body: '{"messages":[]}' }, guard),
				).rejects.toMatchObject({ phase: "before_dispatch" });
				expect(send).toHaveBeenCalledTimes(1);
				expect(guard).toHaveBeenCalledTimes(2);
				await expect(
					call(HTTPS_ENV, "gw", { body: '{"messages":[]}' }, async () => {}),
				).rejects.toMatchObject({ phase: "before_dispatch" });
				expect(send).toHaveBeenCalledTimes(1);
			} finally {
				globalThis.fetch = realFetch;
			}
		},
	);
});

it.each([
	["synchronous value", () => 1],
	[
		"thenable",
		() => ({
			then(resolve: (value: undefined) => void) {
				resolve(undefined);
			},
		}),
	],
] as const)(
	"rejects a %s from the private guard without a wire send",
	async (_label, guard) => {
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		try {
			const transport = resolveAiGatewayTransport(
				HTTPS_ENV,
				"g",
				"workers-ai",
				guard,
			)!;
			await expect(
				transport.fetch(transport.providerRoot),
			).rejects.toMatchObject({
				name: "ProviderDispatchGuardError",
				phase: "before_dispatch",
				providerRequestSent: false,
			});
			expect(send).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

it("preserves the original HTTPS fetch reference for an unguarded client", () => {
	const transport = resolveAiGatewayTransport(HTTPS_ENV, "gw", "azure-openai")!;
	expect(transport.kind).toBe("https");
	expect(transport.fetch).toBe(globalThis.fetch);
});
