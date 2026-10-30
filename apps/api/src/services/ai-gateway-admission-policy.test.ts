import { modelCatalogEntry } from "@tedix/api-contract/test/model-catalog";
import { describe, expect, it } from "vite-plus/test";
import {
	aiGatewayModelTierAllowed,
	resolveAiGatewayAdmissionPolicy,
} from "./ai-gateway-admission-policy";

const catalog = [
	modelCatalogEntry("azure-openai/sample-economy", { tier: "economy" }),
	modelCatalogEntry("azure-openai/sample-frontier", { tier: "frontier" }),
];
describe("AI Gateway admission policy", () => {
	it("composes organization and tedi model tiers by intersection", () => {
		const policy = resolveAiGatewayAdmissionPolicy({
			organization: {
				allowedModelTiers: ["economy", "balanced"],
				dailySpendLimitMicros: 2_000_000,
			},
			tedi: { allowedModelTiers: ["economy"] },
		});
		expect(
			aiGatewayModelTierAllowed(
				"azure-openai",
				"sample-economy",
				policy,
				catalog,
			),
		).toBe(true);
		expect(
			aiGatewayModelTierAllowed(
				"azure-openai",
				"sample-frontier",
				policy,
				catalog,
			),
		).toBe(false);
	});

	it("fails closed for an unknown model when a tier boundary exists", () => {
		const policy = resolveAiGatewayAdmissionPolicy({
			organization: { allowedModelTiers: ["economy"] },
		});
		expect(aiGatewayModelTierAllowed("azure-openai", "unknown", policy)).toBe(
			false,
		);
	});
});

it("rejects unknown refs even without any tier restriction", () => {
	expect(
		aiGatewayModelTierAllowed("azure-openai", "unknown", {}, catalog),
	).toBe(false);
	expect(
		aiGatewayModelTierAllowed("azure-openai", "sample-economy", {}, catalog),
	).toBe(true);
	expect(aiGatewayModelTierAllowed("azure-openai", "sample-economy", {})).toBe(
		false,
	);
});

it("uses the canonical Auto ref for its Workers AI transport identity", () => {
	const registry = [modelCatalogEntry("cloudflare/auto", { tier: "balanced" })];
	expect(
		aiGatewayModelTierAllowed(
			"workers-ai",
			"cloudflare/auto",
			{ organization: { allowedModelTiers: ["balanced"] } },
			registry,
		),
	).toBe(true);
	expect(
		aiGatewayModelTierAllowed(
			"workers-ai",
			"cloudflare/auto",
			{ organization: { allowedModelTiers: ["economy"] } },
			registry,
		),
	).toBe(false);
	expect(
		aiGatewayModelTierAllowed(
			"workers-ai",
			"cloudflare/unregistered",
			{},
			registry,
		),
	).toBe(false);
});
