import { describe, expect, it } from "vite-plus/test";
import { plainModelLabel } from "./plain-model-label";

describe("plainModelLabel", () => {
	it("names a model without where it runs or its id path", () => {
		expect(plainModelLabel("Workers AI: @cf/moonshotai/kimi-k2.7-code")).toBe(
			"Kimi K2.7 Code",
		);
		expect(plainModelLabel("Azure deployment: gpt-5.5-mini")).toBe(
			"GPT 5.5 Mini",
		);
		expect(plainModelLabel("Claude Sonnet")).toBe("Claude Sonnet");
	});
});
