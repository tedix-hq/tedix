import { describe, it, expect } from "vite-plus/test";
import {
	AttentionLayoutSchema,
	DEFAULT_ATTENTION_LAYOUT,
} from "./attention-layout";
describe("Attention composition", () => {
	it("allows fixed widgets to be arranged without executable content", () => {
		expect(
			AttentionLayoutSchema.parse({
				widgets: ["cards", "now"],
				focusToday: "Documentation",
			}).widgets,
		).toEqual(["cards", "now"]);
		expect(
			AttentionLayoutSchema.safeParse({ widgets: ["now", "now"] }).success,
		).toBe(false);
		expect(
			AttentionLayoutSchema.safeParse({ widgets: ["javascript:alert(1)"] })
				.success,
		).toBe(false);
		expect(
			AttentionLayoutSchema.safeParse({
				...DEFAULT_ATTENTION_LAYOUT,
				userId: "someone-else",
			}).success,
		).toBe(false);
	});
});
