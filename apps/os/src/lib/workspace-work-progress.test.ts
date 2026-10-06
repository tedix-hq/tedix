import { describe, expect, it } from "vite-plus/test";
import { workProgress } from "./workspace-work-progress";

describe("workspace progress", () => {
	const item = { id: "work", disposition: "accepted" as const };
	const now = Date.parse("2026-09-21T12:00:00Z");
	const attempt = {
		workItemId: "work",
		runtimeState: "running",
		expiresAt: "2026-09-21T12:05:00Z",
		attemptNumber: 1,
	};
	it("uses live attempt state without inventing a queue state from missing data", () => {
		expect(workProgress(item, [], now)).toBe("accepted");
		expect(workProgress(item, [attempt], now)).toBe("running");
		expect(workProgress(item, [{ ...attempt, workItemId: "other" }], now)).toBe(
			"accepted",
		);
	});
	it("does not report expired or superseded attempts as running", () => {
		expect(workProgress(item, [attempt], now + 300_000)).toBe("accepted");
		expect(
			workProgress(
				item,
				[attempt, { ...attempt, attemptNumber: 2, runtimeState: "waiting" }],
				now,
			),
		).toBe("waiting");
		expect(
			workProgress({ ...item, disposition: "completed" }, [attempt], now),
		).toBe("completed");
	});
});
