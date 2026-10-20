import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { limitLevel, limitRows, LimitsSection } from "./limits-section";

function posture(
	budget: Partial<ComputePosture["budget"]> = {},
	admission: Partial<ComputePosture["admissionPolicy"]> = {},
): ComputePosture {
	return {
		budget: {
			configured: true,
			includedTokens: 1_000_000,
			usedTokens: 400_000,
			reservedTokens: 0,
			remainingIncludedTokens: 600_000,
			unlimitedTokenUsage: false,
			allowOverage: false,
			entitlementActive: true,
			detail: "",
			...budget,
		},
		admissionPolicy: {
			state: "d1_authoritative",
			desiredDailyTokenLimit: null,
			desiredDailySpendLimitMicros: null,
			detail: "",
			...admission,
		},
	} as ComputePosture;
}

describe("limitLevel", () => {
	it("is null without a share, then ok, warn at 80%, full at 100%", () => {
		expect(limitLevel(null)).toBeNull();
		expect(limitLevel(0.79)).toBe("ok");
		expect(limitLevel(0.8)).toBe("warn");
		expect(limitLevel(1)).toBe("full");
	});
});

describe("LimitsSection", () => {
	it("shows a meter and no alert under 80%", () => {
		const html = renderToStaticMarkup(<LimitsSection posture={posture()} />);
		expect(html).toContain("400,000 of 1,000,000 tokens used");
		expect(html).toContain('data-slot="meter"');
		expect(html).not.toContain("data-limit-alert");
	});

	it("warns at 80% and blocks at 100% in plain English", () => {
		expect(
			renderToStaticMarkup(
				<LimitsSection posture={posture({ usedTokens: 850_000 })} />,
			),
		).toContain('data-limit-alert="warn"');
		const full = renderToStaticMarkup(
			<LimitsSection posture={posture({ usedTokens: 1_000_000 })} />,
		);
		expect(full).toContain('data-limit-alert="full"');
		expect(full).toContain("New AI replies pause");
	});

	it("never shows 0 for a daily limit without readable usage", () => {
		const html = renderToStaticMarkup(
			<LimitsSection
				posture={posture(
					{ configured: false, unlimitedTokenUsage: null },
					{
						desiredDailyTokenLimit: 500_000,
						desiredDailySpendLimitMicros: 5_000_000,
					},
				)}
			/>,
		);
		expect(html).toContain("Usage not measured");
		expect(html).toContain("tomorrow 00:00 UTC");
		expect(html).not.toContain('data-slot="meter"');
		expect(limitRows(posture({}, { desiredDailyTokenLimit: 1 }))).toHaveLength(
			2,
		);
	});

	it("says so when nothing is readable", () => {
		const html = renderToStaticMarkup(
			<LimitsSection
				posture={posture({ configured: false, unlimitedTokenUsage: null })}
			/>,
		);
		expect(html).toContain("No limits are readable here");
	});
});
