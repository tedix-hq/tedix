import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ recordBillingProviderUsage: vi.fn() }));

vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingProviderUsage: mocks.recordBillingProviderUsage,
}));

import { recordVoiceProviderUsage } from "./voice-provider-usage";

describe("recordVoiceProviderUsage", () => {
	beforeEach(() => {
		mocks.recordBillingProviderUsage.mockReset();
	});

	it("prices and records a directly observed Flux session without customer metering", async () => {
		mocks.recordBillingProviderUsage.mockResolvedValue({
			id: "usage-1",
			providerCostMicros: 7_700,
			metadata: { rateCardVersion: "workers-ai-2026-07-31" },
		});
		const result = await recordVoiceProviderUsage({} as never, {
			organizationId: "org-1",
			tediId: "tedi-1",
			providerUsageId: "voice:call-1",
			gatewayLogId: "gateway-log-1",
			provider: "workers-ai",
			model: "@cf/deepgram/flux",
			usageKind: "voice_stt",
			unit: "seconds",
			quantity: 60,
			occurredAt: "2026-07-31T12:00:00.000Z",
			metadata: { callId: "call-1" },
		});

		expect(mocks.recordBillingProviderUsage).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				organizationId: "org-1",
				providerUsageId: "voice:call-1",
				gatewayLogId: "gateway-log-1",
				quantity: 60,
				providerCostMicros: 7_700,
				providerCostQuality: "estimated",
				metadata: expect.objectContaining({
					recordingPath: "direct_voice_runtime",
					pricingStatus: "estimated",
				}),
			}),
		);
		expect(result).toEqual({
			usageId: "usage-1",
			providerCostMicros: 7_700,
			providerCostQuality: "estimated",
			rateCardVersion: "workers-ai-2026-07-31",
		});
	});
});
