import { describe, expect, it } from "vite-plus/test";
import {
	MAX_CODE_DESCRIPTION_CHARS,
	buildCodeDescription,
} from "./code-description";

function summaries(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		name: `ns${i % 40}_tool_with_a_long_name_${i}`,
		description: "",
		paramSummary: "(organizationId: string, query?: string, limit?: number)",
	}));
}

describe("buildCodeDescription", () => {
	it("inlines signatures for a small tool set", () => {
		const description = buildCodeDescription(summaries(3), undefined);
		expect(description).toContain("ns0_tool_with_a_long_name_0(");
	});

	it("stays within the cap however many tools there are", () => {
		for (const count of [50, 500, 5_000]) {
			const description = buildCodeDescription(summaries(count), undefined);
			expect(description.length).toBeLessThanOrEqual(
				MAX_CODE_DESCRIPTION_CHARS,
			);
			expect(description).toContain("codemode.__tools()");
			expect(description).not.toContain("_name_49(");
		}
	});
});
