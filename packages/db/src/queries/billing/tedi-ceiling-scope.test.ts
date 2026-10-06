import { describe, expect, it } from "vite-plus/test";

/**
 * The scope rule, expressed as the arithmetic both the INSERT and the denial
 * ladder now use: organization capacity applies to organization ceilings, and
 * a tedi is bounded by its own budget.
 */
const tediAdmits = (
	tediDayTokens: number,
	estimate: number,
	tediLimit: number,
	orgCapacity = 0,
) => tediDayTokens + estimate <= tediLimit + Math.max(0, orgCapacity);

const orgAdmits = (
	orgDayTokens: number,
	estimate: number,
	orgLimit: number,
	orgCapacity: number,
) => orgDayTokens + estimate <= orgLimit + orgCapacity;

describe("capacity scope", () => {
	it("does not let a sponsorship debit lower a tedi ceiling", () => {
		// A provider org: -3,000,000 org capacity from 5 sponsorships. Its
		// operator tedi.s own budget is 10,000,000/day and it had used almost
		// none of it, yet the old arithmetic charged it the org.s debit.
		const orgCapacity = -3_000_000;
		const tediLimit = 10_000_000;
		// Old rule: tediLimit + orgCapacity = 7,000,000, so a tedi under its own
		// budget was refused for a debit it never incurred.
		expect(tediAdmits(8_000_000, 20_000, tediLimit + orgCapacity)).toBe(false);
		// New rule: the debit is clamped out of the tedi ceiling.
		expect(tediAdmits(8_000_000, 20_000, tediLimit, orgCapacity)).toBe(true);
	});

	it("still lets PURCHASED capacity raise a tedi ceiling", () => {
		// The clamp is one-directional on purpose: buying a capacity pack to
		// lift a tedi that is at its budget stays supported.
		expect(tediAdmits(1_000, 2, 1_000)).toBe(false);
		expect(tediAdmits(1_000, 2, 1_000, 5_000_000)).toBe(true);
	});

	it("still applies the debit to the organization that owns it", () => {
		// The sponsorship genuinely spent the ORG's headroom; that must hold.
		const orgCapacity = -3_000_000;
		expect(orgAdmits(1_900_000, 20_000, 5_000_000, orgCapacity)).toBe(true);
		expect(orgAdmits(1_990_000, 20_000, 5_000_000, orgCapacity)).toBe(false);
	});
});
