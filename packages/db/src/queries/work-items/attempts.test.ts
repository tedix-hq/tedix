import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	buildWorkAttemptSettlementMetadata,
	recordWorkAttemptRepository,
} from "./attempts";

const NOW = "2026-10-01T00:00:00.000Z";
const IDS = {
	workItemId: "22222222-2222-4222-8222-222222222222",
	admissionId: "33333333-3333-4333-8333-333333333333",
	attemptId: "11111111-1111-4111-8111-111111111111",
};

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE work_attempts (
		id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL,
		executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT,
		external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL, outcome TEXT,
		attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
		expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1,
		metadata TEXT NOT NULL DEFAULT '{}'
	);`);
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,
			 attempt_number,started_at,heartbeat_at,expires_at,metadata)
			VALUES (?,?,?,'org','tedi','worker','running',1,?,?,?,'{"caller":"kept"}')`,
		)
		.run(
			IDS.attemptId,
			IDS.admissionId,
			IDS.workItemId,
			NOW,
			NOW,
			"2026-10-01T01:00:00.000Z",
		);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const repository = {
	version: 1 as const,
	provider: "cloudflare_artifacts" as const,
	status: "ready" as const,
	mode: "create" as const,
	repositoryName: `work-22222222-${IDS.attemptId}`,
	repositoryId: "repo-1",
	remote: "https://example.artifacts.cloudflare.net/git/tedix/repo.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: null,
	...IDS,
	workItemVersion: 1,
	admissionSpecRevision: "spec-1",
	observedAt: NOW,
	reason: null,
};

describe("recordWorkAttemptRepository", () => {
	it("merges provenance under the live Attempt fence", async () => {
		const { sqlite, db } = fixture();
		const attempt = await recordWorkAttemptRepository(db, {
			orgId: "org",
			...IDS,
			executor: { type: "tedi", id: "worker" },
			repository,
			recordedAt: NOW,
		});
		expect(attempt.metadata).toMatchObject({ caller: "kept", repository });
		expect(
			JSON.parse(
				(
					sqlite
						.prepare("SELECT metadata FROM work_attempts WHERE id = ?")
						.get(IDS.attemptId) as { metadata: string }
				).metadata,
			),
		).toMatchObject({ caller: "kept", repository });
	});

	it("rejects mismatched provenance and elapsed leases", async () => {
		const { db } = fixture();
		await expect(
			recordWorkAttemptRepository(db, {
				orgId: "org",
				...IDS,
				executor: { type: "tedi", id: "worker" },
				repository: { ...repository, attemptId: crypto.randomUUID() },
				recordedAt: NOW,
			}),
		).rejects.toThrow("does not match");
		await expect(
			recordWorkAttemptRepository(db, {
				orgId: "org",
				...IDS,
				executor: { type: "tedi", id: "worker" },
				repository,
				recordedAt: "2026-10-01T02:00:00.000Z",
			}),
		).rejects.toThrow("no longer authoritative");
	});

	it("preserves repository provenance and adds canonical lifecycle receipts", () => {
		const repositoryLifecycle = {
			version: 1 as const,
			headRevision: "b".repeat(40),
			review: {
				status: "approved" as const,
				evidenceRef: "https://github.com/tedix-hq/tedix/pull/42",
				reviewedAt: "2026-10-01T01:00:00.000Z",
			},
			merge: {
				status: "merged" as const,
				canonicalLedger: "github_main" as const,
				repository: "tedix-hq/tedix",
				commitSha: "c".repeat(40),
				mergedAt: "2026-10-01T01:05:00.000Z",
			},
			deployment: {
				status: "deployed" as const,
				surface: "api",
				revision: "version-1",
				evidenceRef: "https://api.tedix.tech/health",
				observedAt: "2026-10-01T01:10:00.000Z",
			},
		};
		const merged = buildWorkAttemptSettlementMetadata({
			priorMetadata: { caller: "kept", repository },
			metadata: {
				settlement: { mode: "commit", commitSha: "c".repeat(40) },
				repository: { forged: true },
			},
			repositoryLifecycle,
			attemptId: IDS.attemptId,
			workItemId: IDS.workItemId,
		});
		expect(merged).toMatchObject({
			caller: "kept",
			repository,
			repositoryLifecycle,
			settlement: { commitSha: "c".repeat(40) },
		});
	});

	it("rejects lifecycle claims without this Attempt's ready repository", () => {
		expect(() =>
			buildWorkAttemptSettlementMetadata({
				priorMetadata: {},
				repositoryLifecycle: {
					version: 1,
					headRevision: "b".repeat(40),
					review: {
						status: "not_reviewed",
						evidenceRef: null,
						reviewedAt: null,
					},
					merge: {
						status: "not_merged",
						canonicalLedger: null,
						repository: null,
						commitSha: null,
						mergedAt: null,
					},
					deployment: {
						status: "not_deployed",
						surface: null,
						revision: null,
						evidenceRef: null,
						observedAt: null,
					},
				},
				attemptId: IDS.attemptId,
				workItemId: IDS.workItemId,
			}),
		).toThrow("ready Artifacts repository");
	});
});
