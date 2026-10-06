import { describe, expect, it } from "vite-plus/test";
import { PublishProviderModelRateInputSchema } from "./provider-model-pricing";

const input = {
	provider: "azure-openai",
	modelId: "model",
	deploymentScope: "account/region/deployment",
	effectiveFrom: "2026-10-01T00:00:00.000Z",
	inputMicrousdPerMillion: 1,
	outputMicrousdPerMillion: 2,
	cacheReadMicrousdPerMillion: 0,
	cacheWriteMicrousdPerMillion: 1,
	currency: "USD",
	evidenceUri: "https://evidence.test/retained",
	evidenceDigest: "a".repeat(64),
	verifiedAt: "2026-09-30T00:00:00.000Z",
	changeReason: "Reviewed provider price",
	supersedesRateVersionId: null,
};

describe("provider rate publication", () => {
	it("publishes a start without an expiry field", () => {
		expect(PublishProviderModelRateInputSchema.parse(input)).not.toHaveProperty(
			"effectiveUntil",
		);
	});
	it("rejects legacy expiry fields", () => {
		for (const effectiveUntil of [null, "2026-11-01T00:00:00.000Z"])
			expect(
				PublishProviderModelRateInputSchema.safeParse({
					...input,
					effectiveUntil,
				}).success,
			).toBe(false);
	});
});
