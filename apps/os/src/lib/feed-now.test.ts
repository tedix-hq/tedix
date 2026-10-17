import { expect, it } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { feedNow } from "./feed-now";

it("counts today's unresolved choices once and links the earliest unresolved deadline", () => {
	const item = ActivityFeedItemSchema.parse({
		id: "cedar-ask",
		actor: "Cedar",
		sentence: "Choose a supplier.",
		source: "/work/interactions/cedar",
		projectId: null,
		tediId: null,
		workItemId: null,
		kind: "decision",
		classId: "supplier",
		importance: "high",
		at: "2026-10-17T10:00:00Z",
		dueAt: "2026-10-17T12:00:00Z",
		needsAction: true,
		stalled: false,
		done: false,
		explanation: "A supplier is waiting.",
		reactions: [],
	});
	const future = { ...item, id: "pine-ask", dueAt: "2026-10-20T12:00:00Z" };
	const done = {
		...item,
		id: "old-ask",
		dueAt: "2026-10-16T12:00:00Z",
		done: true,
	};
	const result = feedNow(
		[item, item, future, done],
		new Date("2026-10-17T10:00:00Z"),
	);
	expect(result.needsToday).toBe(1);
	expect(result.next?.source).toBe("/work/interactions/cedar");
	expect(feedNow([done], new Date()).next).toBeNull();
	const later = { ...item, dueAt: "2026-10-18T10:00:00Z" };
	const evening = new Date("2026-10-17T22:30:00Z");
	expect(feedNow([later], evening, "Asia/Tokyo").needsToday).toBe(1);
	expect(feedNow([later], evening, "America/Los_Angeles").needsToday).toBe(0);
});
