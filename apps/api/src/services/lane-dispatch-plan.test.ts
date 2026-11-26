import { expect, it } from "vite-plus/test";
import { mentionedExecutor } from "./lane-dispatch-plan";
it("records explicit delegation mentions without guessing arbitrary names", () => {
	expect(
		mentionedExecutor(
			"Delegated by Cloud Lead to the Mac Lead session on Sam's request",
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
