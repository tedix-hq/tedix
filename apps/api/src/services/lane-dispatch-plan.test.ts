import { expect, it } from "vite-plus/test";
import { initialLaneDispatch } from "./lane-dispatch-plan";
it("holds both code executors only for opt-in queues and resets previous selections on reassignment", () => {
	expect(initialLaneDispatch("codex", { labels: ["night-shift"] })).toEqual({
		state: "held",
	});
	expect(
		initialLaneDispatch("claude-code", { nightShift: { enabled: true } }),
	).toEqual({ state: "held" });
	expect(initialLaneDispatch("codex", { tags: ["night-shift"] })).toEqual({
		state: "held",
	});
	expect(initialLaneDispatch("codex", {}, { state: "ready" })).toEqual({
		state: "held",
	});
	expect(initialLaneDispatch("codex", {})).toBeUndefined();
	expect(
		initialLaneDispatch("human", { labels: ["night-shift"] }),
	).toBeUndefined();
	expect(
		initialLaneDispatch("tedi", { labels: ["night-shift"] }),
	).toBeUndefined();
});
