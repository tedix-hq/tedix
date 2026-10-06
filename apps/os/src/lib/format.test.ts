import { describe, expect, it } from "vite-plus/test";
import {
	formatCount,
	formatRatioPercent,
	humanize,
	sentenceCase,
} from "./format";

describe("formatCount", () => {
	it("thousands-separates large counts", () => {
		expect(formatCount(13490)).toBe("13,490");
		expect(formatCount(999)).toBe("999");
		expect(formatCount(0)).toBe("0");
	});
});

describe("formatRatioPercent", () => {
	it("formats canonical ratios as human percentages", () => {
		expect(formatRatioPercent(0.532258064516129)).toBe("53.2%");
		expect(formatRatioPercent(0.5)).toBe("50%");
		expect(formatRatioPercent(0)).toBe("0%");
		expect(formatRatioPercent(1)).toBe("100%");
	});
});

describe("humanize", () => {
	it("replaces underscores with spaces", () => {
		expect(humanize("requires_approval")).toBe("requires approval");
		expect(humanize("task")).toBe("task");
	});
});

describe("sentenceCase", () => {
	it("sentence-cases humanized statuses", () => {
		expect(sentenceCase("requires_approval")).toBe("Requires approval");
		expect(sentenceCase("in_progress")).toBe("In progress");
		expect(sentenceCase("done")).toBe("Done");
		expect(sentenceCase("")).toBe("");
	});
});
