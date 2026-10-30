import { expect, test } from "bun:test";
import { workQueueState } from "./queue.js";

const item = {
	version: 3,
	activeAttempt: null,
	latestAttempt: null,
	metadata: { executor: "codex", laneDispatch: { state: "ready" } },
};

test("recorded results and holds do not consume the runnable queue", () => {
	for (const executor of ["codex", "opencode", "devin"]) {
		const current = { ...item, metadata: { ...item.metadata, executor } };
		expect(workQueueState(current)).toBe("queued");
		expect(
			workQueueState({
				...current,
				latestAttempt: { outcome: "succeeded", workItemVersion: 3 },
			}),
		).toBe("awaiting-closure");
		expect(
			workQueueState({
				...current,
				latestAttempt: { outcome: "failed", workItemVersion: 3 },
			}),
		).toBe("failed");
		expect(
			workQueueState({
				...current,
				metadata: { executor, laneDispatch: { state: "held" } },
			}),
		).toBe("waiting");
	}
});

test("a new specification can run, while an older server remains unknown", () => {
	expect(
		workQueueState({
			...item,
			latestAttempt: { outcome: "succeeded", workItemVersion: 2 },
		}),
	).toBe("queued");
	expect(workQueueState({ ...item, latestAttempt: undefined })).toBe("unknown");
	expect(
		workQueueState({
			...item,
			latestAttempt: { outcome: "succeeded", workItemVersion: null },
		}),
	).toBe("awaiting-closure");
});

test("live holders and future work do not become spare queue capacity", () => {
	expect(workQueueState({ ...item, activeAttempt: { expiresAt: null } })).toBe(
		"running",
	);
	expect(
		workQueueState({
			...item,
			activeAttempt: { expiresAt: "2026-01-01T00:00:00Z" },
		}),
	).toBe("waiting");
	expect(workQueueState({ ...item, startAt: "2099-01-01T00:00:00Z" })).toBe(
		"waiting",
	);
});
