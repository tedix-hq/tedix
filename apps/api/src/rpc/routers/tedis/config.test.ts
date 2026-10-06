import { describe, expect, it } from "vite-plus/test";

import { chatModelRefFromRuntimeOverrides } from "../../../lib/tedi-model-overrides";
import { TediModelPolicyResponseSchema } from "@tedix/api-contract/schemas/tedi";

describe("model generation response contract", () => {
	it("preserves explicit generation settings alongside a model override", () => {
		const response = {
			chatModelRef: "azure-openai/gpt-5.6-terra",
			cronModelRef: "cloudflare/auto",
			observerModelRef: "cloudflare/auto",
			generation: {
				chat: { reasoningEffort: "high", maxOutputTokens: 32_000 },
				cron: { reasoningEffort: "low" },
			},
		};
		expect(TediModelPolicyResponseSchema.parse(response)).toEqual(response);
	});
	it("rejects unsupported settings rather than silently stripping them", () => {
		expect(() =>
			TediModelPolicyResponseSchema.parse({
				chatModelRef: null,
				cronModelRef: null,
				observerModelRef: null,
				generation: { chat: { thinking: "high" } },
			}),
		).toThrow();
	});
});

function overridesWithPrimary(primary: unknown): Record<string, unknown> {
	return { agents: { defaults: { model: { primary } } } };
}

describe("chatModelRefFromRuntimeOverrides", () => {
	it("returns a canonical catalog ref for a catalog-format override", () => {
		expect(
			chatModelRefFromRuntimeOverrides(
				overridesWithPrimary("azure-openai/gpt-5.6-terra"),
			),
		).toBe("azure-openai/gpt-5.6-terra");
	});

	it("rejects removed noncanonical provider aliases", () => {
		expect(
			chatModelRefFromRuntimeOverrides(
				overridesWithPrimary("azure-openai-responses/gpt-5.6-terra"),
			),
		).toBeNull();
	});

	it("accepts workers-ai catalog refs", () => {
		expect(
			chatModelRefFromRuntimeOverrides(
				overridesWithPrimary("workers-ai/@cf/openai/gpt-oss-120b"),
			),
		).toBe("workers-ai/@cf/openai/gpt-oss-120b");
	});

	it("rejects refs that are not in the cognition catalog", () => {
		expect(
			chatModelRefFromRuntimeOverrides(
				overridesWithPrimary("azure-openai/gpt-9-imaginary"),
			),
		).toBeNull();
	});

	it("rejects unknown providers", () => {
		expect(
			chatModelRefFromRuntimeOverrides(
				overridesWithPrimary("mystery-provider/gpt-5.6-terra"),
			),
		).toBeNull();
	});

	it("rejects malformed refs", () => {
		expect(
			chatModelRefFromRuntimeOverrides(overridesWithPrimary("gpt-5.6-terra")),
		).toBeNull();
		expect(
			chatModelRefFromRuntimeOverrides(overridesWithPrimary("azure-openai/")),
		).toBeNull();
		expect(
			chatModelRefFromRuntimeOverrides(overridesWithPrimary("")),
		).toBeNull();
		expect(
			chatModelRefFromRuntimeOverrides(overridesWithPrimary(42)),
		).toBeNull();
	});

	it("returns null when the override branch is absent", () => {
		expect(chatModelRefFromRuntimeOverrides(null)).toBeNull();
		expect(chatModelRefFromRuntimeOverrides(undefined)).toBeNull();
		expect(chatModelRefFromRuntimeOverrides({})).toBeNull();
		expect(
			chatModelRefFromRuntimeOverrides({ agents: { defaults: {} } }),
		).toBeNull();
	});
});
