import { expect, it } from "vite-plus/test";
import { readToday, TODAY_COLUMNS, todayShortcut } from "./today-digest";
import { workHomeSearch } from "./work-home-search";
const project = "11111111-1111-4111-8111-111111111111";
it("reads one saved edition and its receipts while rejecting external links", () => {
	const digest = readToday({
		kind: "document",
		blocks: [
			{ type: "paragraph", text: "Help the team." },
			{ type: "paragraph", text: "Updated today." },
			{ type: "paragraph", text: "6 projects quiet" },
			{
				type: "table",
				headers: TODAY_COLUMNS,
				rows: [
					[
						"Website",
						"Make it useful.",
						"1 task finished.",
						"Nothing running now.",
						"2",
						"/projects/example",
						"/work?view=feed",
						"/work?view=deck",
					],
					["Unsafe", "", "", "", "0", "//elsewhere.example", "/work", "/work"],
				],
			},
			{
				type: "table",
				headers: ["Project", "Receipt", "Summary", "Source", "Time"],
				rows: [
					[
						project,
						"doc",
						"Plan updated.",
						"/outputs/doc",
						"2026-10-18T09:00:00.000Z",
					],
				],
			},
		],
	});
	expect(digest?.rows).toHaveLength(1);
	expect(digest?.receipts[0]).toMatchObject({
		sentence: "Plan updated.",
		projectId: project,
		source: "/outputs/doc",
		done: true,
	});
	expect(digest?.quiet).toBe("6 projects quiet");
});
it("keeps project and day scope on the existing Work entry", () => {
	expect(workHomeSearch({ view: "deck", project, day: "2026-10-18" })).toEqual({
		view: "deck",
		project,
		day: "2026-10-18",
	});
	expect(workHomeSearch({ project: "foreign", day: "yesterday" })).toEqual({});
});
it("jumps to Today without taking t from text editing or modified shortcuts", () => {
	expect(todayShortcut(new KeyboardEvent("keydown", { key: "t" }))).toBe(true);
	expect(
		todayShortcut(new KeyboardEvent("keydown", { key: "t", ctrlKey: true })),
	).toBe(false);
	const input = document.createElement("input");
	const event = new KeyboardEvent("keydown", { key: "t" });
	Object.defineProperty(event, "target", { value: input });
	expect(todayShortcut(event)).toBe(false);
});
