import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CreditUsage } from "@/lib/billing-credits";
import { LimitsSection, limitRows } from "./limits-section";

function credits(overrides: Partial<CreditUsage> = {}): CreditUsage {
	return {
		periodStart: "2026-11-01T00:00:00.000Z",
		periodEnd: "2026-12-01T00:00:00.000Z",
		includedCredits: 15_000,
		usedCredits: 6_000,
		remainingIncludedCredits: 9_000,
		topUpCredits: 0,
		breakdown: { ai: 5_000, codeRuns: 600, services: 400 },
		notices: [],
		payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		tedis: [
			{
				tediId: "tedi-fictional-a",
				name: "Nova",
				usedCredits: 1_700,
				monthlyCapCredits: 2_000,
			},
			{
				tediId: "tedi-fictional-b",
				name: "Miles",
				usedCredits: 900,
				monthlyCapCredits: null,
			},
		],
		members: [
			{
				userId: "user-fictional-a",
				name: "Sam Rivera",
				usedCredits: 500,
				monthlyCapCredits: 500,
			},
		],
		...overrides,
	};
}

describe("monthly limits", () => {
	it("lists the plan credits and every cap that is set, all monthly", () => {
		const rows = limitRows(credits());
		expect(rows.map((row) => row.id)).toEqual([
			"monthly-credits",
			"tedi:tedi-fictional-a",
			"member:user-fictional-a",
		]);
		expect(rows[0]!.limitLabel).toBe("15,000 credits a month from the plan");
	});

	it("adds the pay-as-you-go cap in credits when it is on", () => {
		const rows = limitRows(
			credits({
				payAsYouGo: {
					enabled: true,
					monthlyCapMicros: 50_000_000,
					spentMicros: 10_000_000,
				},
			}),
		);
		const payg = rows.find((row) => row.id === "pay-as-you-go")!;
		expect(payg.used).toBe(1_000);
		expect(payg.limit).toBe(5_000);
	});

	it("warns at 80% and says what happens at 100%", () => {
		const html = renderToStaticMarkup(<LimitsSection credits={credits()} />);
		expect(html).toContain('data-limit-alert="warn"');
		expect(html).toContain("Nova monthly cap is nearly used up");
		expect(html).toContain('data-limit-alert="full"');
		expect(html).toContain(
			"Work started by Sam Rivera pauses until next month.",
		);
		expect(html.toLowerCase()).not.toContain("token");
		expect(html.toLowerCase()).not.toContain("daily");
	});
});
