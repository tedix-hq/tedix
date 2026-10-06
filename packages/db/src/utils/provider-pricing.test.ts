import { describe, expect, test } from "vite-plus/test";
import {
	estimateProviderUnitCostMicros,
	PROVIDER_UNIT_PRICING_VERSION,
} from "./provider-pricing";

describe("provider unit pricing", () => {
	test("prices Flux connected seconds using the published per-minute rate", () => {
		expect(
			estimateProviderUnitCostMicros({
				provider: "workers-ai",
				model: "@cf/deepgram/flux",
				usageKind: "voice_stt",
				unit: "seconds",
				quantity: 60,
			}),
		).toEqual({
			providerCostMicros: 7_700,
			rateCardVersion: PROVIDER_UNIT_PRICING_VERSION,
		});
	});

	test("prices Aura 1 characters using the published per-1,000 rate", () => {
		expect(
			estimateProviderUnitCostMicros({
				provider: "workers-ai",
				model: "@cf/deepgram/aura-1",
				usageKind: "voice_tts",
				unit: "characters",
				quantity: 1_000,
			}),
		).toEqual({
			providerCostMicros: 15_000,
			rateCardVersion: PROVIDER_UNIT_PRICING_VERSION,
		});
	});

	test("keeps unknown provider units visible but unpriced", () => {
		expect(
			estimateProviderUnitCostMicros({
				provider: "gradium",
				model: "gradium-streaming-stt",
				usageKind: "voice_stt",
				unit: "seconds",
				quantity: 30,
			}),
		).toEqual({ providerCostMicros: 0, rateCardVersion: null });
	});
});
