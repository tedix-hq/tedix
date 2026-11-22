import { expect, it } from "vite-plus/test";
import { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
import {
	aggregateHarnessScorecard,
	SCORECARD_WINDOW_MS,
} from "./harness-scorecard";

const now = Date.parse("2026-11-07T12:00:00.000Z");
function row(id: number, overrides: Record<string, unknown> = {}) {
	return WorkAttemptProjectionSchema.parse({
		attempt: {
			id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
			orgId: "11111111-1111-4111-8111-111111111111",
			workItemId: "22222222-2222-4222-8222-222222222222",
			executorType: "external_agent",
			executorId: "cedar",
			executorSessionId: null,
			externalSessionKey: "codex:session",
			runtimeState: "running",
			outcome: null,
			runId: null,
			admissionId: null,
			attemptNumber: 1,
			startedAt: new Date(now).toISOString(),
			heartbeatAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 60_000).toISOString(),
			finishedAt: null,
			summary: null,
			metadata: {},
			...overrides,
		},
		workItem: {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Cedar task",
			disposition: "accepted",
			workKind: "coding",
			riskLevel: "low",
			priority: "medium",
			projectId: null,
			accountableOwnerType: null,
			accountableOwnerId: null,
		},
	});
}

it("uses a bounded start-time cohort and deduplicates Attempts across scopes", () => {
	const success = row(1, { outcome: "succeeded" });
	const rows = aggregateHarnessScorecard(
		[
			success,
			success,
			row(2, { outcome: "failed" }),
			row(3, { outcome: "expired" }),
			row(4, { expiresAt: new Date(now).toISOString() }),
			row(5, {
				outcome: "cancelled",
				expiresAt: new Date(now - 1).toISOString(),
			}),
			row(9, {
				outcome: "landed_unverified",
				runtimeState: "finished",
				expiresAt: new Date(now - 1).toISOString(),
			}),
			row(6, { startedAt: new Date(now - SCORECARD_WINDOW_MS).toISOString() }),
			row(7, {
				startedAt: new Date(now - SCORECARD_WINDOW_MS - 1).toISOString(),
			}),
			row(8, { startedAt: new Date(now + 1).toISOString() }),
		],
		now,
	);
	// Done counts succeeded and landed; failed counts failed and expired.
	// Running and cancelled Attempts are started but neither.
	expect(rows).toEqual([
		{ runner: "codex", started: 7, done: 2, failed: 2, commits: 0 },
	]);
	expect(
		aggregateHarnessScorecard([success], now + SCORECARD_WINDOW_MS + 1),
	).toEqual([]);
});

it("attributes harnesses by stamped session key and retains unattributed and tedi Attempts", () => {
	const rows = aggregateHarnessScorecard(
		[
			row(1, {
				externalSessionKey: "claude:session",
				metadata: { executor: "codex" },
			}),
			row(2, {
				externalSessionKey: null,
				executorSessionId: "codex:unverified",
			}),
			row(3, { executorType: "tedi", externalSessionKey: null }),
			row(4, { externalSessionKey: "bare-session-key" }),
		],
		now,
	);
	expect(rows.map((row) => row.runner)).toEqual(["other", "claude", "tedi"]);
});

it("counts unique dispatcher commit receipts, excluding declared or recovered existing fixes", () => {
	const sha = "a".repeat(40);
	const receipt = {
		lane: true,
		settlement: {
			mode: "commit",
			commitShas: [sha, sha, "b".repeat(40)],
		},
	};
	const rows = aggregateHarnessScorecard(
		[
			row(1, { metadata: receipt }),
			row(2, { metadata: receipt }),
			row(3, {
				metadata: { lane: true, laneResult: { commitSha: "c".repeat(40) } },
			}),
			row(4, {
				metadata: {
					lane: true,
					settlement: { mode: "verified_existing", commitSha: "d".repeat(40) },
				},
			}),
			row(5, {
				metadata: { settlement: { mode: "commit", commitSha: "e".repeat(40) } },
			}),
			row(6, { metadata: { lane: true, settlement: [sha] } }),
		],
		now,
	);
	expect(rows[0]?.commits).toBe(2);
});
