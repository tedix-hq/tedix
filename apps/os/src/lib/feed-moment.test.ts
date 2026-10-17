import { expect, it } from "vite-plus/test";
import { feedMoment } from "./feed-moment";

it("labels moments in the person's timezone, including a different calendar day", () => {
	const now = new Date("2026-10-18T01:00:00Z");
	expect(feedMoment("2026-10-17T18:00:00Z", now, "America/Los_Angeles")).toBe(
		"This morning",
	);
	expect(feedMoment("2026-10-17T23:30:00Z", now, "Europe/Berlin")).toBe(
		"This morning",
	);
	expect(feedMoment("2026-10-17T18:00:00Z", now, "Europe/Berlin")).toBe(
		"Earlier",
	);
});

it("keeps morning, afternoon and evening boundaries local", () => {
	const now = new Date("2026-10-17T21:00:00Z");
	expect(feedMoment("2026-10-17T10:00:00Z", now, "Europe/Berlin")).toBe(
		"This afternoon",
	);
	expect(feedMoment("2026-10-17T16:00:00Z", now, "Europe/Berlin")).toBe(
		"This evening",
	);
});
