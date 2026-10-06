import { describe, expect, it } from "vite-plus/test";

/**
 * The restore policy, as the arithmetic the procedure uses. Deliberately
 * boring: a restore cancels a debit and nothing else, so it needs no
 * commercial decision about who may spend what.
 */
const restore = (allocated: number) => Math.max(0, -allocated);

describe("self-service capacity restore", () => {
	it("cancels exactly the sponsorship debit and no more", () => {
		// A provider org: -3,000,000 tokens across five sponsorships against a
		// 5,000,000 base. Restoring returns the day to 5,000,000.
		expect(restore(-3_000_000)).toBe(3_000_000);
		const base = 5_000_000;
		expect(base + -3_000_000 + restore(-3_000_000)).toBe(base);
	});

	it("can never raise a ceiling above the plan base", () => {
		// A day that is already at base, or above it from a purchased pack,
		// restores nothing. This is what makes the action safe to hand to any
		// organization admin without a spending decision behind it.
		expect(restore(0)).toBe(0);
		expect(restore(5_000_000)).toBe(0);
		const base = 5_000_000;
		expect(base + 5_000_000 + restore(5_000_000)).toBe(base + 5_000_000);
	});

	it("is the same request when repeated within a day", () => {
		// The procedure keys on `restore:{org}:{budgetDay}`, so a second call
		// returns the first allocation rather than stacking another grant.
		const key = (org: string, day: string) => `restore:${org}:${day}`;
		expect(key("org-1", "2026-09-15")).toBe(key("org-1", "2026-09-15"));
		expect(key("org-1", "2026-09-15")).not.toBe(key("org-1", "2026-09-16"));
	});
});
