import { describe, expect, it, vi } from "vite-plus/test";
import {
	outputRevisionListenerCount,
	publishOutputRevisionNotice,
	subscribeOutputRevisionNotices,
	type OutputRevisionEvent,
} from "./output-revision-notices";

describe("file change notices in the browser", () => {
	it("delivers a workspace's notices to its listeners only, until they leave", () => {
		const mine = vi.fn();
		const other = vi.fn();
		const leave = subscribeOutputRevisionNotices("ws-1", mine);
		const leaveOther = subscribeOutputRevisionNotices("ws-2", other);
		const event: OutputRevisionEvent = {
			type: "revision",
			workspaceId: "ws-1",
			outputId: "file",
			revisionId: "rev",
			revision: 3,
		};
		publishOutputRevisionNotice(event);
		publishOutputRevisionNotice({ type: "resync", workspaceId: "ws-1" });
		expect(mine.mock.calls).toEqual([
			[event],
			[{ type: "resync", workspaceId: "ws-1" }],
		]);
		expect(other).not.toHaveBeenCalled();
		leave();
		publishOutputRevisionNotice(event);
		expect(mine).toHaveBeenCalledTimes(2);
		leaveOther();
		expect(outputRevisionListenerCount()).toBe(0);
	});
});
