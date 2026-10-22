import type { TediSessionMessage } from "@tedix/tedi-session/session-harness";
import { describe, expect, it } from "vite-plus/test";
import {
	AZURE_CONTEXT_WINDOW_TOKENS,
	maxPromptTokensForWindow,
	WORKERS_AI_CONTEXT_WINDOW_TOKENS,
} from "../../src/rpc/routers/kernel/context-relevance";
import {
	CHECKPOINT_MAX_CHARS,
	COMPACTION_TARGET_RATIO,
	compactKernelHistory,
	getHistoryTokenLimits,
	historyReplayChars,
	MAX_RETAINED_HISTORY_CHARS,
} from "../../src/rpc/routers/kernel/context-compaction";

const MESSAGE_CHARS = 100;
const TURN_CHARS = (MESSAGE_CHARS + 20) * 2;

function longHistory(): TediSessionMessage[] {
	return Array.from({ length: 1_000 }, (_, turn) => [
		{ role: "user" as const, content: `u${turn}:${"q".repeat(MESSAGE_CHARS)}` },
		{
			role: "assistant" as const,
			content: `a${turn}:${"r".repeat(MESSAGE_CHARS)}`,
		},
	]).flat();
}

const PROMPT_BUDGETS = [
	["Azure route", maxPromptTokensForWindow(AZURE_CONTEXT_WINDOW_TOKENS)],
	[
		"Workers AI route",
		maxPromptTokensForWindow(WORKERS_AI_CONTEXT_WINDOW_TOKENS),
	],
	["one-million-token budget", 1_000_000],
] as const;

describe("post-compaction prompt size", () => {
	it.each(PROMPT_BUDGETS)(
		"bounds history for the %s",
		async (_route, budget) => {
			const limits = getHistoryTokenLimits(budget, 0);
			const compacted = await compactKernelHistory(longHistory(), limits);

			expect(compacted).not.toBeNull();
			const replayChars = historyReplayChars(compacted!.replay);
			const boundarySlack = CHECKPOINT_MAX_CHARS + TURN_CHARS;
			expect(replayChars).toBeLessThanOrEqual(
				Math.min(
					Math.floor(limits.historyBudgetChars * COMPACTION_TARGET_RATIO),
					MAX_RETAINED_HISTORY_CHARS,
				) + boundarySlack,
			);
			expect(Math.ceil(replayChars / 4)).toBeLessThanOrEqual(
				Math.ceil((MAX_RETAINED_HISTORY_CHARS + boundarySlack) / 4),
			);
		},
	);
});
