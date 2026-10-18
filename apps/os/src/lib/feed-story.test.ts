import { expect, it } from "vite-plus/test";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { timelineItems, feedStoryActor } from "./feed-story";

it("keeps pending and resolved deck cards out of posts and tells the story in time order", () => {
	const row = (id: string, kind: ActivityFeedItem["kind"], at: string) =>
		({ id, kind, at }) as ActivityFeedItem;
	expect(
		timelineItems([
			row("old", "result", "2026-10-17T10:00:00Z"),
			row("pending", "decision", "2026-10-18T12:00:00Z"),
			row("approval", "approval", "2026-10-18T12:00:00Z"),
			row("new", "work", "2026-10-18T11:00:00Z"),
		]).map((item) => item.id),
	).toEqual(["new", "old"]);
});

it("names the actual tedi when known, otherwise attributes the coding lane to its project", () => {
	expect(
		feedStoryActor(
			{ actor: "Codex session", tediId: null } as ActivityFeedItem,
			"Therion",
			{},
		),
	).toBe("Codex for Therion");
	expect(
		feedStoryActor(
			{ actor: "Tedi", tediId: "cedar" } as ActivityFeedItem,
			"Therion",
			{ cedar: "CTO tedi" },
		),
	).toBe("CTO tedi");
});
