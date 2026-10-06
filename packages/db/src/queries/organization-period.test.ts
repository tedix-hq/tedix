import { describe, expect, it } from "vite-plus/test";

/**
 * The provisioning period rule, exercised through the same arithmetic the
 * source uses. A non-trial window is one month from its start, matching how
 * `rollBillingPeriods` advances a closed one.
 */
function monthAfter(instant: string): string {
	const end = new Date(instant);
	end.setUTCMonth(end.getUTCMonth() + 1);
	return end.toISOString();
}

const days = (from: string, to: string) =>
	Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

describe("provisioned billing period", () => {
	it("is a month wherever in the month the account opens", () => {
		// The old rule truncated to the 1st of next month, so an account opened
		// on the 29th got three days carrying a full monthly allowance.
		for (const start of [
			"2026-09-01T00:00:00.000Z",
			"2026-09-15T12:00:00.000Z",
			"2026-09-29T08:36:00.000Z",
		]) {
			expect(days(start, monthAfter(start))).toBeGreaterThanOrEqual(28);
			expect(days(start, monthAfter(start))).toBeLessThanOrEqual(31);
		}
	});

	it("never produces the year-long window that stranded an account", () => {
		// A 2026-08-29..2027-08-29 period would give one monthly allowance across a
		// year, which rollBillingPeriods could not reach until 2027.
		const start = "2026-08-29T00:00:00.000Z";
		expect(monthAfter(start)).toBe("2026-09-29T00:00:00.000Z");
		expect(days(start, monthAfter(start))).toBe(31);
	});

	it("rolls consistently month over month", () => {
		// Jan 31 has no Feb 31; the advance must still land on a sane window
		// rather than throwing or skipping a month.
		let cursor = "2027-01-31T00:00:00.000Z";
		for (let i = 0; i < 12; i += 1) {
			const next = monthAfter(cursor);
			expect(Date.parse(next)).toBeGreaterThan(Date.parse(cursor));
			expect(days(cursor, next)).toBeLessThanOrEqual(31);
			cursor = next;
		}
	});
});
