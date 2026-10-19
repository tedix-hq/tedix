import { expect, it } from "vite-plus/test";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import {
	timelineItems,
	feedStoryActor,
} from "@tedix/api-contract/utils/feed-story";

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

it("names the harness from provenance and the actual tedi when known", () => {
	expect(
		feedStoryActor(
			{
				actor: "Unrelated display label",
				tediId: null,
				actorIdentity: { type: "external_agent", harness: "codex" },
			} as ActivityFeedItem,
			{},
		),
	).toBe("Codex");
	expect(
		feedStoryActor({ actor: "Tedi", tediId: "cedar" } as ActivityFeedItem, {
			cedar: "CTO tedi",
		}),
	).toBe("CTO tedi");
});

it("collapses retry outcomes per Work and identical sentences within thirty minutes", () => {
	const row = (
		id: string,
		workItemId: string,
		at: string,
		sentence: string,
		outcome = "succeeded",
	) =>
		({
			id,
			workItemId,
			at,
			sentence,
			kind: "result",
			classId: `external_agent:result:${outcome}`,
		}) as ActivityFeedItem;
	expect(
		timelineItems([
			row("new", "one", "2026-10-18T10:10:00Z", "The fix is ready."),
			row("retry", "one", "2026-10-18T10:05:00Z", "The same fix finished."),
			row("duplicate", "two", "2026-10-18T10:04:00Z", "The fix is ready."),
			row(
				"failure",
				"one",
				"2026-10-18T10:03:00Z",
				"The check failed.",
				"failed",
			),
			row("yesterday", "one", "2026-10-17T10:00:00Z", "The fix is ready."),
		]).map((item) => item.id),
	).toEqual(["new", "failure", "yesterday"]);
});
