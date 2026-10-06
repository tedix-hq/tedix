import { describe, expect, it } from "vite-plus/test";
import {
	isToolExcludedFromSkillCoverage,
	parseToolSkillCoverageMetadata,
	TEDIX_TOOL_SKILL_COVERAGE_META_KEY,
	ToolMetaSchema,
} from "./tools";

describe("tool skill coverage metadata", () => {
	it("recognizes excluded tools", () => {
		const meta = {
			[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: {
				status: "excluded",
				category: "internal-contract",
				reason: "oRPC route is tagged internal.",
			},
		};

		expect(isToolExcludedFromSkillCoverage(meta)).toBe(true);
		expect(parseToolSkillCoverageMetadata(meta)?.category).toBe(
			"internal-contract",
		);
	});

	it("keeps tools auditable by default", () => {
		expect(isToolExcludedFromSkillCoverage(null)).toBe(false);
		expect(
			isToolExcludedFromSkillCoverage({
				[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: { status: "required" },
			}),
		).toBe(false);
	});

	it("validates the metadata shape inside tool meta", () => {
		expect(
			ToolMetaSchema.safeParse({
				[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: { status: "nope" },
			}).success,
		).toBe(false);
	});
});
