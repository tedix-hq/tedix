/**
 * Standalone assertions for the shared AI Gateway transport resolution
 * (`@tedix/workers-ai/gateway-transport`) AS THIS WORKER USES IT, and the Azure
 * chat URL/headers `llm.ts` builds on top of it. Run directly:
 * `bun run src/ai-gateway-transport.test.ts`.
 *
 * The load-bearing guarantees:
 *   - an allowlisted provider addresses the gateway on the BINDING host, which
 *     carries no account id, and leaves through `env.AI.fetch` with its body
 *     untouched;
 *   - a provider that is NOT allowlisted (an out-of-account gateway) still
 *     resolves the public HTTPS path with `CF_AI_GATEWAY_TOKEN`;
 *   - the allowlist, not the presence of the `AI` binding, is the opt-out.
 */
import assert from "node:assert/strict";
import {
	AI_GATEWAY_BINDING_AUTH,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";
import {
	type AzureChatEnv,
	azureChatHeaders,
	azureChatUrl,
	azureGatewayFetch,
	usingAzureGateway,
} from "./llm";

function binding(fetchImpl: (...args: never[]) => Promise<Response>): Ai {
	return { fetch: fetchImpl } as unknown as Ai;
}

const noopFetch = async () => new Response("{}");

{
	// Allowlisted → binding host, no account id, sentinel auth.
	const transport = resolveAiGatewayTransport(
		{
			AI: binding(noopFetch),
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			CF_AI_GATEWAY_TOKEN: "aig-token",
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai,azure-openai",
		},
		"gw",
		"azure-openai",
	);
	assert.equal(transport?.kind, "binding");
	assert.equal(
		transport?.providerRoot,
		"https://workers-binding.ai/ai-gateway/gateways/gw/azure-openai",
	);
	assert.ok(!transport?.providerRoot.includes("acct123"));
	assert.equal(transport?.authorization, AI_GATEWAY_BINDING_AUTH);
	assert.notEqual(transport?.authorization, "aig-token");
}

{
	// NOT allowlisted (out-of-account gateway) → public HTTPS + token, even
	// though the AI binding is present for env.AI.run / toMarkdown.
	const transport = resolveAiGatewayTransport(
		{
			AI: binding(noopFetch),
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			CF_AI_GATEWAY_TOKEN: "aig-token",
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
		},
		"gw",
		"azure-openai",
	);
	assert.equal(transport?.kind, "https");
	assert.equal(
		transport?.providerRoot,
		"https://gateway.ai.cloudflare.com/v1/acct123/gw/azure-openai",
	);
	assert.equal(transport?.authorization, "aig-token");
}

{
	// Blank / unset allowlist keeps every provider on HTTPS.
	for (const allowlist of [undefined, "", " , "]) {
		const transport = resolveAiGatewayTransport(
			{
				AI: binding(noopFetch),
				AI_GATEWAY_ACCOUNT_ID: "acct123",
				CF_AI_GATEWAY_TOKEN: "aig-token",
				AI_GATEWAY_BINDING_PROVIDERS: allowlist,
			},
			"gw",
			"workers-ai",
		);
		assert.equal(transport?.kind, "https");
	}
	// Neither transport configured → null.
	assert.equal(
		resolveAiGatewayTransport(
			{ AI_GATEWAY_ACCOUNT_ID: "acct" },
			"gw",
			"workers-ai",
		),
		null,
	);
}

{
	// Azure chat over the binding needs no token at all.
	const calls: Array<[string, RequestInit | undefined]> = [];
	const env = {
		AZURE_OPENAI_RESOURCE: "tedix-resource",
		AZURE_OPENAI_API_VERSION: "preview",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
		AI_GATEWAY_ACCOUNT_ID: "acct123",
		AI_GATEWAY_LLM_ID: "example-gateway",
		AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		AI: binding((async (url: string, init?: RequestInit) => {
			calls.push([url, init]);
			return new Response("{}");
		}) as never),
	} as unknown as AzureChatEnv;

	assert.equal(usingAzureGateway(env), true);
	assert.equal(azureChatHeaders(env)["cf-aig-no-wholesale"], "true");
	const url = azureChatUrl(env, "gpt-5.6-luna");
	assert.equal(
		url,
		"https://workers-binding.ai/ai-gateway/gateways/example-gateway/azure-openai/tedix-resource/gpt-5.6-luna/chat/completions?api-version=preview",
	);
	assert.equal(
		azureChatHeaders(env)["cf-aig-authorization"],
		`Bearer ${AI_GATEWAY_BINDING_AUTH}`,
	);

	const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
	await azureGatewayFetch(env)(url, {
		method: "POST",
		body,
		headers: azureChatHeaders(env),
	});
	assert.equal(
		new Headers(calls[0]?.[1]?.headers).get("cf-aig-no-wholesale"),
		"true",
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.[0], url);
	// Passed through verbatim — never re-enveloped.
	assert.equal(calls[0]?.[1]?.body, body);
}

{
	// Same isolate, gateway NOT in-account: HTTPS + token, global fetch.
	const bindingCalls: string[] = [];
	const env = {
		AZURE_OPENAI_RESOURCE: "tedix-resource",
		AZURE_OPENAI_API_VERSION: "preview",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
		AI_GATEWAY_ACCOUNT_ID: "acct123",
		AI_GATEWAY_LLM_ID: "example-gateway",
		CF_AI_GATEWAY_TOKEN: "aig-token",
		AI: binding((async (url: string) => {
			bindingCalls.push(url);
			return new Response("{}");
		}) as never),
	} as unknown as AzureChatEnv;
	assert.equal(
		azureChatUrl(env, "gpt-5.6-luna"),
		"https://gateway.ai.cloudflare.com/v1/acct123/example-gateway/azure-openai/tedix-resource/gpt-5.6-luna/chat/completions?api-version=preview",
	);
	assert.equal(
		azureChatHeaders(env)["cf-aig-authorization"],
		"Bearer aig-token",
	);
	assert.equal(azureChatHeaders(env)["cf-aig-no-wholesale"], "true");
	// Not the binding's fetch: the request goes out over the public internet.
	assert.notEqual(
		azureGatewayFetch(env),
		(env.AI as unknown as { fetch: unknown }).fetch,
	);
	assert.deepEqual(bindingCalls, []);
}

console.log("ai-gateway-transport.test.ts: all assertions passed");
