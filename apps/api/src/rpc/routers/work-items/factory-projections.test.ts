import { describe, expect, it } from "vite-plus/test";
import {
	ATTEMPT_PROJECTION_SUMMARY_CHARS,
	boundAttemptProjectionSummary,
} from "./factory-projections";

describe("attempt projection summaries", () => {
	it("keeps short and missing summaries unchanged", () => {
		expect(boundAttemptProjectionSummary(null)).toBeNull();
		expect(boundAttemptProjectionSummary("Pushed 1a2b3c4.")).toBe(
			"Pushed 1a2b3c4.",
		);
	});

	it("fits a five-row settled-history page inside a delegated tool result", () => {
		// Replay of the backlog closeout: settled attempts whose summaries carry
		// whole agent transcripts clipped every page, even at limit 3-5.
		const transcript = `Failed: ${"I'll resume this Work and inspect the sample repository state. ".repeat(120)}`;
		const row = (n: number) => ({
			attempt: {
				id: `00000000-0000-4000-8000-00000000000${n}`,
				workItemId: "00000000-0000-4000-8000-0000000000aa",
				runtimeState: "failed",
				outcome: "failed",
				summary: boundAttemptProjectionSummary(transcript),
				metadata: {
					agentSession: "sample:session",
					settlement: { commitSha: "1a2b3c4d5e6f" },
				},
			},
			workItem: { id: "00000000-0000-4000-8000-0000000000aa", title: "Sample" },
			laneState: null,
		});
		const summary = boundAttemptProjectionSummary(transcript);
		expect(summary?.length).toBe(ATTEMPT_PROJECTION_SUMMARY_CHARS);
		expect(summary?.endsWith("…")).toBe(true);
		const page = JSON.stringify({
			data: [1, 2, 3, 4, 5].map(row),
			nextCursor: null,
			hasMore: false,
		});
		expect(transcript.length).toBeGreaterThan(7_000);
		expect(page.length).toBeLessThan(12_000);
	});
});
