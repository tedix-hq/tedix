import { describe, expect, it } from "vite-plus/test";
import {
	aiGatewayModelTierAllowed,
	resolveAiGatewayAdmissionPolicy,
} from "./ai-gateway-admission-policy";

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
			aiGatewayModelTierAllowed("azure-openai", "gpt-5.6-luna", policy),
		).toBe(true);
		expect(
			aiGatewayModelTierAllowed("azure-openai", "gpt-5.6-terra", policy),
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
