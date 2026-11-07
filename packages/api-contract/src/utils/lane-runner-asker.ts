import { z } from "zod";

const laneRequest = z.object({
	source: z.literal("lane-dispatch-blocker"),
	laneBlocker: z.object({
		executor: z.enum(["codex", "claude-code", "opencode", "devin"]),
	}),
});

const names = {
	codex: "Codex runner",
	"claude-code": "Claude Code runner",
	opencode: "OpenCode runner",
	devin: "Devin runner",
};

/** Runner provenance is separate from the authenticated carrier and grants no authority. */
export function laneRunnerAsker(metadata: unknown): string | undefined {
	const parsed = laneRequest.safeParse(metadata);
	return parsed.success ? names[parsed.data.laneBlocker.executor] : undefined;
}
