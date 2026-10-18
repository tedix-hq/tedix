import { expect, it, vi } from "vite-plus/test";
import { feedbackToday } from "./learned-today";
vi.mock("@/lib/api", () => ({ osApi: {} }));
it("counts only the owner's active feedback on the person's local day", () => {
	const base = {
		id: "fixture",
		text: "Use short status updates.",
		learnedFrom: null,
		fromCallerFeedback: true,
		addedAt: "2026-10-17T23:30:00Z",
		evidence: {
			version: 1 as const,
			state: "live" as const,
			supportCount: 1,
			sources: [
				{
					id: "fixture-source",
					kind: "correction" as const,
					quote: "Use short status updates.",
				},
			],
		},
	};
	expect(
		feedbackToday(
			[
				base,
				{ ...base, id: "other", fromCallerFeedback: false },
				{ ...base, id: "yesterday", addedAt: "2026-10-17T18:00:00Z" },
			],
			new Date("2026-10-18T12:00:00Z"),
			"Europe/Berlin",
		).map((x) => x.id),
	).toEqual(["fixture"]);
});
