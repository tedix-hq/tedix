import { expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { buildActivityFeedTools } from "./activity-feed-webmcp-tools";

it("uses the visible card's reaction callback and rejects stale ids and empty corrections", async () => {
	const item = ActivityFeedItemSchema.parse({
		id: "factory:pine:1",
		actor: "Pine",
		sentence: "A supplier replied.",
		source: "/outputs/pine",
		projectId: null,
		tediId: null,
		workItemId: null,
		kind: "result",
		classId: "supplier",
		importance: "normal",
		at: "2026-10-17T12:00:00.000Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: false,
		explanation: "Source message",
		reactions: ["more", "why", "mute", "comment"],
	});
	const react = vi.fn(async () => true);
	const tools = buildActivityFeedTools(() => ({
		items: [item],
		busy: false,
		react,
	}));
	const write = tools.find((t) => t.name === "react_activity_feed")!;
	const stale = await write.execute({ itemId: "gone", reaction: "mute" });
	expect(stale.isError).toBe(true);
	expect(
		(await write.execute({ itemId: item.id, reaction: "comment", text: " " }))
			.isError,
	).toBe(true);
	expect(react).not.toHaveBeenCalled();
	await write.execute({ itemId: item.id, reaction: "more" });
	expect(react).toHaveBeenCalledWith(item, "more", "");
	expect(tools.some((t) => /approve|settle|create_work/.test(t.name))).toBe(
		false,
	);
});
