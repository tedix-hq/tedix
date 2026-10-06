import { describe, expect, it } from "vite-plus/test";
import { validateExtraction } from "./extraction-validator";

describe("content extraction quality", () => {
	it("accepts a complete article without commerce price or image fields", () => {
		const result = validateExtraction(
			[
				{
					title: "Article",
					url: "https://example.com/article",
					description: "Useful summary",
				},
			],
			"content",
			"normalized",
		);
		expect(result).toMatchObject({
			valid: true,
			score: 1,
			coverage: { expected: 3, present: 3, missing: [] },
		});
	});

	it("reports missing description in content coverage", () => {
		const result = validateExtraction(
			[{ title: "Article", url: "https://example.com/article" }],
			"content",
			"pre-insert",
		);
		expect(result.coverage).toMatchObject({
			expected: 3,
			present: 2,
			missing: ["description"],
		});
		expect(result.coverage.missing).not.toContain("price");
		expect(result.coverage.missing).not.toContain("image");
	});
});
