import { describe, expect, it } from "vite-plus/test";
import { creditNoticeCopy } from "./credit-notice-copy";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("credit notice copy", () => {
	it.each([80, 100] as const)(
		"leads with %i%% in a short story",
		(threshold) => {
			const copy = creditNoticeCopy({
				threshold,
				organizationName: "Willowbrook",
			});
			expect(copy.subject).toBe(
				`Willowbrook has used ${threshold}% of this month's credits`,
			);
			expect(copy.story.startsWith(copy.subject)).toBe(true);
			expect(words(copy.story)).toBeLessThan(60);
			expect(copy.story.split(/(?<=\.)\s/)).toHaveLength(3);
			expect(copy.story).not.toMatch(/\d+ credits/);
			expect(copy.story).toContain(
				"Buy a credit pack or turn on pay-as-you-go to keep working.",
			);
		},
	);

	it("says what happens next at 80%", () => {
		expect(creditNoticeCopy({ threshold: 80 }).story).toBe(
			"Your organization has used 80% of this month's credits. At 100%, tedis and code runs pause until the month resets. Buy a credit pack or turn on pay-as-you-go to keep working.",
		);
	});
});
