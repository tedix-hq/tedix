import { describe, expect, it } from "vite-plus/test";
import {
	allowanceShare,
	allowanceUsage,
	availableCredits,
	creditLevel,
	creditsPaused,
	type CreditUsage,
	formatCredits,
	formatUsagePercent,
	latestCreditNotice,
	monthlyAllowanceCredits,
	parseCreditCap,
	parseEuroCapMicros,
	usagePercent,
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
		expect(usagePercent(150, 100)).toBe(100);
	});

	it("rounds percent down, shows <1% for small usage, 100% only at the limit", () => {
		expect(formatUsagePercent(0, 1_000)).toBe("0%");
		expect(formatUsagePercent(1, 1_000)).toBe("<1%");
		expect(formatUsagePercent(9, 1_000)).toBe("<1%");
		expect(formatUsagePercent(10, 1_000)).toBe("1%");
		expect(formatUsagePercent(29, 100)).toBe("29%");
		expect(formatUsagePercent(999, 1_000)).toBe("99%");
		expect(formatUsagePercent(1_000, 1_000)).toBe("100%");
		expect(formatUsagePercent(5, 0)).toBe("100%");
		expect(usagePercent(1, 1_000)).toBe(0);
	});

	it("measures usage against included plus top-up credits this month", () => {
		const growth = usage({
			includedCredits: 15_000,
			usedCredits: 12_600,
			remainingIncludedCredits: 2_400,
			topUpCredits: 5_000,
		});
		expect(monthlyAllowanceCredits(growth)).toBe(20_000);
		expect(allowanceUsage(growth)).toEqual({ percent: 63, label: "63%" });
		expect(allowanceShare(growth, 2)).toEqual({ percent: 0, label: "<1%" });
		// The 200 top-up credits already drawn this month still count.
		const drawing = usage({
			includedCredits: 1_000,
			usedCredits: 1_200,
			remainingIncludedCredits: 0,
			topUpCredits: 300,
		});
		expect(allowanceUsage(drawing)).toEqual({ percent: 80, label: "80%" });
	});

	it("reads 100% when the organization is out of credits", () => {
		expect(allowanceUsage(usage())).toEqual({ percent: 100, label: "100%" });
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
