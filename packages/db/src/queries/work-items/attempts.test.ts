import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workAttempts } from "../../schema/work-items";
import {
	buildWorkAttemptSettlementMetadata,
	listLatestWorkAttemptSummaries,
	recordWorkAttemptRepository,
	recordWorkAttemptRepositoryCandidate,
	workAttemptCallerMetadata,
	recordWorkAttemptRepositoryCandidatePublication,
	claimWorkAttemptRepositoryCandidatePublication,
	claimWorkAttemptConversationNotice,
	releaseWorkAttemptConversationNotice,
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

describe("latest Work Attempt summaries", () => {
	it("returns the newest canonical result without crossing organizations or requested Work", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`INSERT INTO work_attempts
			(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at,metadata)
			VALUES ('new','${IDS.workItemId}','org','tedi','worker','finished','succeeded',2,'2026-10-02','2026-10-02','2026-10-02','{"dispatchVersion":7}'),
			('foreign','${IDS.workItemId}','other','tedi','worker','failed','failed',3,'2026-10-03','2026-10-03','2026-10-03','{}');`);
		const rows = await listLatestWorkAttemptSummaries(db, {
			orgId: "org",
			workItemIds: [IDS.workItemId, "absent"],
		});
		expect(rows.size).toBe(1);
		expect(rows.get(IDS.workItemId)).toEqual({
			attemptId: "new",
			runtimeState: "finished",
			outcome: "succeeded",
			finishedAt: "2026-10-02",
			workItemVersion: 7,
		});
		expect(
			(
				await listLatestWorkAttemptSummaries(db, {
					orgId: "org",
					workItemIds: [],
				})
			).size,
		).toBe(0);
		sqlite.close();
	});
});

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

describe("server-reserved repository candidate", () => {
	const descriptor = {
		version: 1 as const,
		organizationId: "org",
		...IDS,
		repositoryId: "repo-1",
		repositoryName: "fixture",
		baseRevision: "a".repeat(40),
		files: [{ path: "README.md", blobRevision: "b".repeat(40), bytes: 1 }],
		selectionDigest: "c".repeat(64),
		roomName: "room",
		docKey: "doc",
		createdAt: NOW,
	};
	it("freezes selection once under executor, lease and repository fences", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare("UPDATE work_attempts SET expires_at=?, metadata=? WHERE id=?")
			.run(
				"2099-01-01T00:00:00.000Z",
				JSON.stringify({ caller: "kept", repository }),
				IDS.attemptId,
			);
		const params = {
			orgId: "org",
			...IDS,
			executor: { type: "tedi" as const, id: "worker" },
			descriptor,
		};
		await expect(
			recordWorkAttemptRepositoryCandidate(db, {
				...params,
				executor: { type: "tedi", id: "stranger" },
			}),
		).rejects.toThrow("stale");
		await expect(
			recordWorkAttemptRepositoryCandidate(db, {
				...params,
				descriptor: { ...descriptor, repositoryId: "other" },
			}),
		).rejects.toThrow("stale");
		const result = await recordWorkAttemptRepositoryCandidate(db, params);
		expect(result.metadata).toMatchObject({
			caller: "kept",
			repository,
			repositoryCandidate: descriptor,
		});
		await expect(
			recordWorkAttemptRepositoryCandidate(db, {
				...params,
				descriptor: { ...descriptor, selectionDigest: "d".repeat(64) },
			}),
		).rejects.toThrow("already initialized");
	});
	it("rejects elapsed leases and foreign Work scope", async () => {
		const { db } = fixture();
		const params = {
			orgId: "org",
			...IDS,
			executor: { type: "tedi" as const, id: "worker" },
			descriptor,
		};
		await expect(
			recordWorkAttemptRepositoryCandidate(db, params),
		).rejects.toThrow("stale");
		await expect(
			recordWorkAttemptRepositoryCandidate(db, {
				...params,
				descriptor: { ...descriptor, workItemId: "other" },
			}),
		).rejects.toThrow("provenance");
	});
	it("cannot inject at start or replace at settlement while preserving other metadata", () => {
		expect(
			workAttemptCallerMetadata({
				repositoryCandidate: { forged: true },
				note: "kept",
			}),
		).toEqual({ note: "kept" });
		expect(
			buildWorkAttemptSettlementMetadata({
				priorMetadata: { repositoryCandidate: descriptor, repository },
				metadata: {
					repositoryCandidate: { forged: true },
					repositoryLifecycle: { forged: true },
					note: "kept",
				},
				attemptId: IDS.attemptId,
				workItemId: IDS.workItemId,
			}),
		).toEqual({ repositoryCandidate: descriptor, repository, note: "kept" });
	});
});

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

describe("server-reserved candidate publication CAS", () => {
	function publicationFixture() {
		const f = fixture();
		f.sqlite.exec(
			`CREATE TABLE work_items(id TEXT,org_id TEXT,disposition TEXT,completed_at TEXT,cancelled_at TEXT,admission_spec_revision TEXT);CREATE TABLE work_admissions(id TEXT,work_item_id TEXT,org_id TEXT,decision TEXT,admission_spec_revision TEXT);`,
		);
		f.sqlite
			.prepare(
				"INSERT INTO work_items VALUES (?, 'org','accepted',NULL,NULL,'spec')",
			)
			.run(IDS.workItemId);
		f.sqlite
			.prepare(
				"INSERT INTO work_admissions VALUES (?,?,'org','admitted','spec')",
			)
			.run(IDS.admissionId, IDS.workItemId);
		const descriptor = {
			version: 1 as const,
			organizationId: "org",
			...IDS,
			repositoryId: "repo-1",
			repositoryName: "fixture",
			baseRevision: "a".repeat(40),
			files: [{ path: "README.md", blobRevision: "b".repeat(40), bytes: 1 }],
			selectionDigest: "c".repeat(64),
			roomName: "room",
			docKey: "doc",
			createdAt: NOW,
		};
		const person = {
			name: "Fixture",
			email: "fixture@example.invalid",
			timestamp: 0,
			timezoneOffset: 0,
		};
		const preparation = {
			version: 1 as const,
			descriptor,
			position: { generation: 0, revision: 1 },
			contentDigest: "d".repeat(64),
			repositoryBaseRevision: null,
			targetRef: "refs/heads/main",
			remote: "https://artifacts.example/fixture.git",
			recipe: { message: "fixture", author: person, committer: person },
			treeRevision: "e".repeat(40),
			commitRevision: "f".repeat(40),
			objectManifestDigest: "1".repeat(64),
			unchanged: false,
			preparedAt: NOW,
			preparationDigest: "2".repeat(64),
		};
		const record = { preparation, attemptedAt: null };
		f.sqlite.prepare("UPDATE work_attempts SET metadata=? WHERE id=?").run(
			JSON.stringify({
				repository: { repositoryId: "repo-1" },
				repositoryCandidate: descriptor,
			}),
			IDS.attemptId,
		);
		const params = {
			orgId: "org",
			...IDS,
			executor: { type: "tedi" as const, id: "worker" },
			at: NOW,
		};
		return { ...f, record, params };
	}
	it("reserves an immutable preparation and allows one attempted marker despite heartbeat version changes", async () => {
		const f = publicationFixture();
		expect(
			await recordWorkAttemptRepositoryCandidatePublication(f.db, {
				...f.params,
				record: f.record,
			}),
		).not.toBeNull();
		expect(
			await recordWorkAttemptRepositoryCandidatePublication(f.db, {
				...f.params,
				record: f.record,
			}),
		).toBeNull();
		f.sqlite.exec("UPDATE work_attempts SET version=version+4");
		const params = {
			...f.params,
			preparationDigest: f.record.preparation.preparationDigest,
		};
		expect(
			await claimWorkAttemptRepositoryCandidatePublication(f.db, params),
		).not.toBeNull();
		expect(
			await claimWorkAttemptRepositoryCandidatePublication(f.db, params),
		).toBeNull();
	});
	it.each(["peer", "short lease", "cancelled work", "revoked admission"])(
		"refuses %s before the POST claim",
		async (kind) => {
			const f = publicationFixture();
			await recordWorkAttemptRepositoryCandidatePublication(f.db, {
				...f.params,
				record: f.record,
			});
			const params = {
				...f.params,
				preparationDigest: f.record.preparation.preparationDigest,
			};
			if (kind === "peer") params.executor.id = "peer";
			if (kind === "short lease") params.at = "2026-10-01T00:59:00.000Z";
			if (kind === "cancelled work")
				f.sqlite.exec("UPDATE work_items SET disposition='cancelled'");
			if (kind === "revoked admission")
				f.sqlite.exec("UPDATE work_admissions SET decision='denied'");
			expect(
				await claimWorkAttemptRepositoryCandidatePublication(f.db, params),
			).toBeNull();
		},
	);
	it("cannot inject publication receipts at start or overwrite them at settlement", () => {
		const f = publicationFixture();
		expect(
			workAttemptCallerMetadata({
				repositoryCandidatePublication: { forged: true },
				note: "kept",
			}),
		).toEqual({ note: "kept" });
		expect(
			buildWorkAttemptSettlementMetadata({
				priorMetadata: { repositoryCandidatePublication: f.record },
				metadata: {
					repositoryCandidatePublication: { forged: true },
					note: "kept",
				},
				attemptId: IDS.attemptId,
				workItemId: IDS.workItemId,
			}),
		).toEqual({ repositoryCandidatePublication: f.record, note: "kept" });
	});
});

describe("latest Attempt seek plan", () => {
	it("seeks one latest id per requested Work and fetches only those primary keys across chunks", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl({ expressionIndexes: true }, workAttempts));
		const insert = sqlite.prepare(`INSERT INTO work_attempts
			(id, admission_id, work_item_id, org_id, executor_type, executor_id, runtime_state,
			attempt_number, started_at, heartbeat_at, metadata, finished_at, outcome)
			VALUES (?, ?, ?, ?, 'tedi', 'worker', 'finished', ?, ?, '2026-11-18', ?, '2026-11-18', 'succeeded')`);
		const ids = Array.from({ length: 55 }, (_, i) => `work-${i}`);
		for (const orgId of ["org", "other"])
			for (const workId of ids)
				for (let i = 0; i < 100; i++) {
					const id = `${orgId}-${workId}-${String(i).padStart(3, "0")}`;
					insert.run(
						id,
						id,
						workId,
						orgId,
						i + 1,
						i < 98 ? "2026-11-17" : "2026-11-18",
						JSON.stringify({ dispatchVersion: i }),
					);
				}
		sqlite.exec("ANALYZE");
		const queries: string[] = [];
		const db = createDbQueryClient(
			createD1Facade({
				prepare(query) {
					queries.push(query);
					return sqlite.prepare(query);
				},
				exec(query) {
					sqlite.exec(query);
				},
			}),
		);
		const result = await listLatestWorkAttemptSummaries(db, {
			orgId: "org",
			workItemIds: [...ids, ids[0]!, "absent"],
		});
		expect(result.size).toBe(55);
		for (const id of ids) {
			expect(result.get(id)?.attemptId).toBe(`org-${id}-099`);
			expect(result.get(id)?.workItemVersion).toBe(99);
		}
		expect(queries).toHaveLength(2);
		for (const query of queries) {
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
				.map((row) => String(row.detail))
				.join(" | ");
			expect(plan).toContain(
				"SEARCH work_attempts USING INDEX sqlite_autoindex_work_attempts_1 (id=?)",
			);
			expect(plan).toContain(
				"SEARCH work_attempts USING COVERING INDEX idx_work_attempt_org_item_started (org_id=? AND work_item_id=?)",
			);
			expect(plan).not.toContain("SCAN work_attempts");
			expect(plan).not.toContain("TEMP B-TREE");
		}
		sqlite.close();
	});
});

describe("conversation notice mark", () => {
	const scope = {
		orgId: "org",
		workItemId: IDS.workItemId,
		attemptId: IDS.attemptId,
	};
	const metadata = (sqlite: DatabaseSync) =>
		JSON.parse(
			(
				sqlite
					.prepare("SELECT metadata FROM work_attempts WHERE id=?")
					.get(IDS.attemptId) as { metadata: string }
			).metadata,
		);

	it("is won once per settled Attempt and can be released", async () => {
		const { sqlite, db } = fixture();
		expect(await claimWorkAttemptConversationNotice(db, scope)).toBe(false);
		sqlite.exec(
			"UPDATE work_attempts SET runtime_state='finished', outcome='succeeded'",
		);
		expect(
			await claimWorkAttemptConversationNotice(db, {
				...scope,
				orgId: "other",
			}),
		).toBe(false);
		expect(
			await claimWorkAttemptConversationNotice(db, { ...scope, at: NOW }),
		).toBe(true);
		expect(await claimWorkAttemptConversationNotice(db, scope)).toBe(false);
		expect(metadata(sqlite)).toEqual({
			caller: "kept",
			conversationNotice: { claimedAt: NOW },
		});
		await releaseWorkAttemptConversationNotice(db, scope);
		expect(metadata(sqlite)).toEqual({ caller: "kept" });
		expect(await claimWorkAttemptConversationNotice(db, scope)).toBe(true);
	});

	it("cannot be set by the caller's own metadata", () => {
		expect(
			workAttemptCallerMetadata({
				conversationNotice: { claimedAt: NOW },
				kept: true,
			}),
		).toEqual({ kept: true });
	});
});
