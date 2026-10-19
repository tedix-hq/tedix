import { expect, it } from "vite-plus/test";
import { initialLaneDispatch, mentionedExecutor } from "./lane-dispatch-plan";
it("assignment readies every supported executor", () => {
	for (const executor of ["codex", "claude-code", "devin", "tedi", "human"])
		expect(initialLaneDispatch(executor)).toEqual({ state: "ready" });
	expect(initialLaneDispatch(undefined)).toBeUndefined();
});
it("records explicit delegation mentions without guessing arbitrary names", () => {
	expect(
		mentionedExecutor(
			"Delegated by Cloud Lead to the Mac Lead session on Aaron's request",
			[],
		),
	).toEqual({ executor: "codex" });
	expect(mentionedExecutor("Delegated to Claude Code", [])).toEqual({
		executor: "claude-code",
	});
	expect(
		mentionedExecutor("Delegated to Nova", [
			{ id: "nova", name: "Nova", slug: "nova" },
		]),
	).toEqual({ executor: "tedi", tediId: "nova" });
	expect(mentionedExecutor("Nova discussed a delegation", [])).toBeUndefined();
});
