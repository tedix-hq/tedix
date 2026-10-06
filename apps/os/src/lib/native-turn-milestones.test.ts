import { describe, expect, it } from "vite-plus/test";
import {
	armNativeTurn,
	bindNativeTurn,
	finishNativeTurn,
	markNativeTurnMilestone,
	readNativeTurn,
} from "./native-turn-milestones";

describe("native turn milestone correlation", () => {
	it("survives the route component that armed the first turn", () => {
		armNativeTurn("run-remount", "conversation-bootstrap", 100);
		bindNativeTurn("run-remount", "conversation-workspace");
		// A remounted hook reads module-owned state, not the old component ref.
		expect(readNativeTurn("run-remount")).toEqual({
			conversationId: "conversation-workspace",
			emitted: new Set(),
			startedAt: 100,
		});
		expect(markNativeTurnMilestone("run-remount", "first_text")).not.toBeNull();
		expect(markNativeTurnMilestone("run-remount", "first_text")).toBeNull();
		expect(
			markNativeTurnMilestone("run-remount", "terminal_received"),
		).not.toBeNull();
		expect(finishNativeTurn("run-remount")?.conversationId).toBe(
			"conversation-workspace",
		);
		expect(readNativeTurn("run-remount")).toBeNull();
	});
});
