import { expect, test } from "bun:test";
import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import { priceTurn, turnPricingIdentity } from "./pricing";

const env = {
	AI_GATEWAY_ACCOUNT_ID: "acct-example",
	AI_GATEWAY_LLM_ID: "gateway-example",
	AZURE_OPENAI_RESOURCE: "Example-Resource",
	AZURE_CHAT_DEPLOYMENT: "chat-example",
	CF_AI_GATEWAY_TOKEN: "token",
};

test("prices with the same rate scope that billing records", () => {
	expect(turnPricingIdentity(env, "@cf/example/model")).toEqual({
		provider: "workers-ai",
		modelId: "@cf/example/model",
		deploymentScope: providerDeploymentScope({
			provider: "workers-ai",
			gatewayAccountId: "acct-example",
		} as Parameters<typeof providerDeploymentScope>[0]),
	});
	expect(turnPricingIdentity(env, "azure-openai/chat-example")).toEqual({
		provider: "azure-openai",
		modelId: "chat-example",
		deploymentScope: providerDeploymentScope({
			provider: "azure-openai",
			gatewayAccountId: "acct-example",
			gatewayId: "gateway-example",
			providerOrigin: "https://example-resource.openai.azure.com",
			deployment: "chat-example",
		} as Parameters<typeof providerDeploymentScope>[0]),
	});
});

test("states why a turn has no price instead of showing zero", async () => {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		partial: false,
	};
	expect(
		await priceTurn(undefined, env, "@cf/example/model", usage, "2026-11-09"),
	).toEqual({ costUnavailable: "model not priced here" });
	expect(
		await priceTurn(
			undefined,
			env,
			"@cf/example/model",
			{ ...usage, partial: true },
			"2026-11-09",
		),
	).toEqual({ costUnavailable: "usage incomplete" });
});
