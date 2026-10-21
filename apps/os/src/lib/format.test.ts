import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	formatCardPresentationDates,
	formatCardTextDates,
	formatCount,
	formatRatioPercent,
	humanize,
	sentenceCase,
	setOsFormattingPreferences,
} from "./format";

afterEach(() => setOsFormattingPreferences({ locale: null, timezone: null }));

it.each([1, 2] as const)(
	"formats v%s faces without changing metadata or input",
	(version) => {
		const copy = {
			version,
			title: "Review by 2026-10-20?",
			body: "Saves a task for 2026-10-20.",
			recommendation: "Review because the deadline is 2026-10-20.",
			generatedAt: "2026-10-19T12:00:00Z",
			...(version === 2
				? {
						context: "Due 2026-10-20.",
						stakes: "Expires 2026-10-20.",
						actionLabels: { approve: "Review 2026-10-20" },
					}
				: {}),
		};
		const rendered = formatCardPresentationDates(copy);
		expect(rendered.generatedAt).toBe(copy.generatedAt);
		expect(rendered.title).toBe("Review by Oct 20, 2026?");
		expect(rendered.body).toBe("Saves a task for Oct 20, 2026.");
		expect(rendered.recommendation).toBe(
			"Review because the deadline is Oct 20, 2026.",
		);
		if (rendered.version === 2) {
			expect(rendered.context).toBe("Due Oct 20, 2026.");
			expect(rendered.stakes).toBe("Expires Oct 20, 2026.");
			expect(rendered.actionLabels).toEqual({ approve: "Review Oct 20, 2026" });
		}
		expect(copy.title).toBe("Review by 2026-10-20?");
	},
);

describe("formatCardTextDates", () => {
	it("formats every ISO date while preserving its year and calendar day", () => {
		setOsFormattingPreferences({
			locale: "en-US",
			timezone: "America/Los_Angeles",
		});
		expect(
			formatCardTextDates("Review by 2026-10-20; follow up on 2027-01-02."),
		).toBe("Review by Oct 20, 2026; follow up on Jan 2, 2027.");
	});
	it("uses saved locale and converts instants across midnight", () => {
		setOsFormattingPreferences({
			locale: "de-DE",
			timezone: "America/Los_Angeles",
		});
		expect(formatCardTextDates("Due 2026-10-20T00:30:00Z.")).toBe(
			"Due 19. Okt. 2026, 17:30.",
		);
		setOsFormattingPreferences({ locale: "en-US", timezone: "Europe/Berlin" });
		expect(formatCardTextDates("Due 2026-10-20T00:30:00Z.")).toBe(
			"Due Oct 20, 2026, 2:30 AM.",
		);
	});
	it("leaves invalid dates, unzoned times, URLs and identifiers alone", () => {
		const text =
			"2026-02-30 2026-13-01 2026-10-20T12:00:00 https://example.com/2026-10-20 task_2026-10-20 2026-10-20-extra";
		expect(formatCardTextDates(text)).toBe(text);
	});
	it("is idempotent and accepts leap days", () => {
		const text = formatCardTextDates("Review on 2028-02-29.");
		expect(text).toBe("Review on Feb 29, 2028.");
		expect(formatCardTextDates(text)).toBe(text);
	});
});

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
