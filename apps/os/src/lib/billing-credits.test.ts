import { describe, expect, it } from "vite-plus/test";
import {
	availableCredits,
	creditLevel,
	creditPercent,
	creditsPaused,
	type CreditUsage,
	formatCredits,
	latestCreditNotice,
	parseCreditCap,
	parseEuroCapMicros,
} from "./billing-credits";

function usage(overrides: Partial<CreditUsage> = {}): CreditUsage {
	return {
		periodStart: "2026-11-01T00:00:00.000Z",
		periodEnd: "2026-12-01T00:00:00.000Z",
		includedCredits: 500,
		usedCredits: 500,
		remainingIncludedCredits: 0,
		topUpCredits: 0,
		breakdown: { ai: 450, codeRuns: 30, services: 20 },
		notices: [],
		payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		tedis: [],
		members: [],
		...overrides,
	};
}

describe("Tedix credits", () => {
	it("formats whole credits", () => {
		expect(formatCredits(1)).toBe("1 credit");
		expect(formatCredits(15_000)).toBe("15,000 credits");
	});

	it("warns at 80% and stops at 100%", () => {
		expect(creditLevel(79, 100)).toBe("ok");
		expect(creditLevel(80, 100)).toBe("warn");
		expect(creditLevel(100, 100)).toBe("full");
		expect(creditPercent(150, 100)).toBe(100);
	});

	it("counts plan credits, then top-ups, then pay-as-you-go room", () => {
		expect(availableCredits(usage())).toBe(0);
		expect(creditsPaused(usage())).toBe(true);
		const withRoom = usage({
			topUpCredits: 100,
			payAsYouGo: {
				enabled: true,
				monthlyCapMicros: 5_000_000,
				spentMicros: 1_000_000,
			},
		});
		expect(availableCredits(withRoom)).toBe(500);
		expect(creditsPaused(withRoom)).toBe(false);
	});

	it("picks the highest notice reached", () => {
		expect(latestCreditNotice(usage())).toBeNull();
		expect(
			latestCreditNotice(
				usage({
					notices: [
						{ threshold: 80, reachedAt: "2026-11-10T00:00:00.000Z" },
						{ threshold: 100, reachedAt: "2026-11-20T00:00:00.000Z" },
					],
				}),
			)?.threshold,
		).toBe(100);
	});

	it("accepts only lower, whole-number caps; empty means no separate cap", () => {
		expect(parseCreditCap("", 500)).toEqual({
			ok: true,
			monthlyCapCredits: null,
		});
		expect(parseCreditCap("200", 500)).toEqual({
			ok: true,
			monthlyCapCredits: 200,
		});
		expect(parseCreditCap("2.5", 500).ok).toBe(false);
		expect(parseCreditCap("-1", 500).ok).toBe(false);
		expect(parseCreditCap("501", 500).ok).toBe(false);
	});

	it("parses a positive euro cap into micros", () => {
		expect(parseEuroCapMicros("50")).toBe(50_000_000);
		expect(parseEuroCapMicros("12.34")).toBe(12_340_000);
		expect(parseEuroCapMicros("")).toBeNull();
		expect(parseEuroCapMicros("0")).toBeNull();
		expect(parseEuroCapMicros("2000000")).toBeNull();
	});
});
