import { describe, expect, it } from "vite-plus/test";
import { requireGeminiGateway } from "./blog-generation";

const fakeBinding = { fetch: async () => new Response("{}") } as unknown as Ai;

describe("Gemini blog-generation gateway", () => {
	it("accepts and trims a complete authenticated gateway configuration", () => {
		const transport = requireGeminiGateway({
			accountId: " account ",
			gatewayId: " gateway ",
			token: " token ",
		});
		expect(transport.kind).toBe("https");
		expect(transport.providerRoot).toBe(
			"https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		);
		expect(transport.authorization).toBe("token");
	});

	it("rides the Workers AI binding when google-ai-studio is allowlisted in-account", () => {
		const transport = requireGeminiGateway({
			accountId: "account",
			gatewayId: "gateway",
			binding: fakeBinding,
			bindingProviders: "google-ai-studio",
		});
		expect(transport.kind).toBe("binding");
		// The binding host carries account identity, so the URL has no account id.
		expect(transport.providerRoot).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/gateway/google-ai-studio",
		);
		expect(transport.authorization).toBe("cloudflare-gateway-binding");
	});

	it("stays on HTTPS with its token when the provider is not allowlisted", () => {
		const transport = requireGeminiGateway({
			accountId: "account",
			gatewayId: "gateway",
			token: "token",
			// The binding is bound (env.AI.toMarkdown etc.) but this gateway is not
			// in-account, so the allowlist keeps Gemini on the public path.
			binding: fakeBinding,
			bindingProviders: "workers-ai",
		});
		expect(transport.kind).toBe("https");
		expect(transport.authorization).toBe("token");
	});

	it.each([
		undefined,
		{},
		{ accountId: "account", gatewayId: "gateway" },
		{ accountId: "account", token: "token" },
		{ gatewayId: "gateway", token: "token" },
		// Allowlisted but no binding bound → nothing to ride, and no token either.
		{
			accountId: "account",
			gatewayId: "gateway",
			bindingProviders: "google-ai-studio",
		},
	])("fails closed rather than calling Gemini directly for %j", (gateway) => {
		expect(() => requireGeminiGateway(gateway)).toThrow(
			"AI Gateway is required for Gemini blog generation",
		);
	});
});
