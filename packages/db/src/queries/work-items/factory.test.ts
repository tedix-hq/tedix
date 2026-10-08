import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	heartbeatWorkItemAttempt,
	settleWorkItemAttempt,
	startWorkItemAttempt,
} from "./attempts";
import {
	cancelWorkItem,
	completeWorkItem,
	getWorkItemBySourceIntentId,
	getGoalLoopWorkItemSnapshot,
} from "./crud";
import { getWorkItemEvidence, submitWorkItemEvidence } from "./evidence";
import { WorkFactoryError } from "./factory-state";
import {
	deriveWorkItemReadiness,
	listWorkItemReadinessProjection,
} from "./readiness";

const NOW = "2026-08-20T12:00:00.000Z";
const CONTRACT = JSON.stringify({
	version: 1,
	doneLooksLike: "Done when the named outcome is delivered",
});

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE work_item_relations (
	id TEXT PRIMARY KEY, org_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL,
	to_work_item_id TEXT NOT NULL, relation_type TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE work_attempts (
	id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL,
	executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL,
	outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
	expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uniq_work_attempt_active ON work_attempts (org_id, work_item_id)
	WHERE runtime_state IN ('queued','running','waiting','retrying');
CREATE TABLE work_admissions (
	id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, work_item_version INTEGER NOT NULL,
	admission_spec_revision TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL,
	executor_session_id TEXT, external_session_key TEXT, decision TEXT NOT NULL, rejection_code TEXT,
	rejection_reason TEXT, rejection_key TEXT, max_cost_micros INTEGER, decided_at TEXT NOT NULL,
	expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE work_resource_reservations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL, pool_id TEXT NOT NULL, pool_version INTEGER NOT NULL, resource_key TEXT NOT NULL, quantity INTEGER NOT NULL, state TEXT NOT NULL, reserved_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_budget_reservations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL, envelope_id TEXT NOT NULL, envelope_version INTEGER NOT NULL, amount_micros INTEGER NOT NULL, consumed_micros INTEGER, state TEXT NOT NULL, reserved_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_approval_proposals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, work_item_version INTEGER NOT NULL, authority_key TEXT NOT NULL, action TEXT NOT NULL, proposal TEXT NOT NULL DEFAULT '{}', requester_type TEXT NOT NULL, requester_id TEXT NOT NULL, requester_session_id TEXT, requester_external_session_key TEXT, approver_type TEXT NOT NULL, approver_id TEXT NOT NULL, status TEXT NOT NULL, rationale TEXT NOT NULL, expires_at TEXT NOT NULL, resolution_fence TEXT, created_at TEXT NOT NULL, resolved_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_approval_decisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, resolved_proposal_version INTEGER NOT NULL, decision TEXT NOT NULL, decider_type TEXT NOT NULL, decider_id TEXT NOT NULL, rationale TEXT NOT NULL, decided_at TEXT NOT NULL);
CREATE TABLE work_resource_requirements (org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, resource_key TEXT NOT NULL, quantity INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,work_item_id,resource_key));
CREATE TABLE work_budget_envelopes (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,limit_micros INTEGER NOT NULL,reservation_micros INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'USD',enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_case_items (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,case_id TEXT NOT NULL,work_item_id TEXT NOT NULL,discovered_at TEXT NOT NULL,rationale TEXT);
CREATE TABLE work_evidence (
	id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, attempt_id TEXT,
	claim_key TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT NOT NULL, digest TEXT, media_type TEXT, label TEXT,
	submitted_by_type TEXT NOT NULL, submitted_by_id TEXT NOT NULL, submitted_by_session_id TEXT,
	disposition TEXT NOT NULL DEFAULT 'pending', reviewed_by_type TEXT, reviewed_by_id TEXT,
	reviewed_by_session_id TEXT, review_reason TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT,
	version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uniq_work_evidence_observation ON work_evidence(org_id,work_item_id,claim_key,uri,coalesce(digest,''));
CREATE TABLE work_events (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL,
	work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
	actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL
);
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

function seed(sqlite: DatabaseSync, id: string, disposition = "accepted") {
	sqlite
		.prepare(
			`INSERT INTO work_items
			 (id,org_id,title,disposition,acceptance_contract,accountable_owner_type,accountable_owner_id,created_at,accepted_at,work_class,objective_id)
			 VALUES (?, 'org', ?, ?, ?, 'system', 'test', ?, ?, 'objective', 'objective')`,
		)
		.run(
			id,
			id,
			disposition,
			CONTRACT,
			NOW,
			disposition === "accepted" ? NOW : null,
		);
	if (disposition === "accepted")
		for (const executor of [
			{
				key: "worker",
				type: "tedi",
				id: "worker",
				expiry: "2026-08-20T13:00:00.000Z",
			},
			{
				key: "one",
				type: "tedi",
				id: "one",
				expiry: "2026-08-20T11:00:00.000Z",
			},
			{
				key: "two",
				type: "tedi",
				id: "two",
				expiry: "2026-08-20T13:00:00.000Z",
			},
			{
				key: "agent",
				type: "external_agent",
				id: "agent",
				session: "session",
				expiry: "2026-08-20T13:00:00.000Z",
			},
			{
				key: "agent-final",
				type: "external_agent",
				id: "agent",
				session: "session-id",
				expiry: "2026-08-20T13:00:00.000Z",
			},
		])
			sqlite
				.prepare(
					`INSERT INTO work_admissions (id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,executor_session_id,external_session_key,decision,decided_at,expires_at,created_at) VALUES (?, 'org', ?, 1, 'test-revision', ?, ?, ?, ?, 'admitted', ?, ?, ?)`,
				)
				.run(
					`admission-${id}-${executor.key}`,
					id,
					executor.type,
					executor.id,
					executor.session ?? null,
					executor.type === "external_agent" ? "external-key" : null,
					NOW,
					executor.expiry,
					NOW,
				);
}

describe("artifact-neutral work factory", () => {
	it("atomically rejects a stale admission after the factory retry cap is consumed", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "factory");
		sqlite
			.prepare("UPDATE work_items SET metadata=? WHERE id='factory'")
			.run(JSON.stringify({ factoryCycle: { maxAttempts: 1 } }));
		const first = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "factory",
			admissionId: "admission-factory-worker",
			executor: { type: "tedi", id: "worker" },
			startedAt: NOW,
			expiresAt: "2026-08-20T13:00:00.000Z",
		});
		await settleWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "factory",
			attemptId: first.attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "failed",
			settledAt: "2026-08-20T12:01:00.000Z",
		});
		await expect(
			startWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "factory",
				admissionId: "admission-factory-two",
				executor: { type: "tedi", id: "two" },
				startedAt: "2026-08-20T12:02:00.000Z",
				expiresAt: "2026-08-20T13:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_attempts WHERE work_item_id='factory'",
				)
				.get(),
		).toMatchObject({ count: 1 });
	});

	it("fails closed on malformed factory retry limits", async () => {
		for (const maxAttempts of [0, 6, "2", null]) {
			const { sqlite, db } = fixture();
			seed(sqlite, "factory");
			sqlite
				.prepare("UPDATE work_items SET metadata=? WHERE id='factory'")
				.run(JSON.stringify({ factoryCycle: { maxAttempts } }));
			await expect(
				startWorkItemAttempt(db, {
					orgId: "org",
					workItemId: "factory",
					admissionId: "admission-factory-worker",
					executor: { type: "tedi", id: "worker" },
					startedAt: NOW,
					expiresAt: "2026-08-20T13:00:00.000Z",
				}),
			).rejects.toMatchObject({ code: "NOT_READY" });
		}
	});
	it("resolves a Work Item by its org-scoped source intent", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite
			.prepare("UPDATE work_items SET source_intent_id=? WHERE id='work'")
			.run("child-run-1");

		await expect(
			getWorkItemBySourceIntentId(db, {
				orgId: "org",
				sourceIntentId: "child-run-1",
			}),
		).resolves.toMatchObject({ id: "work", orgId: "org" });
		await expect(
			getWorkItemBySourceIntentId(db, {
				orgId: "other-org",
				sourceIntentId: "child-run-1",
			}),
		).resolves.toBeNull();
	});

	it("counts objective completion independently from its bounded preview", async () => {
		const { sqlite, db } = fixture();
		for (const id of ["a", "b", "c"]) seed(sqlite, id);
		sqlite
			.prepare(
				"UPDATE work_items SET objective_id='objective', disposition=CASE WHEN id='a' THEN 'completed' ELSE disposition END",
			)
			.run();
		expect(
			await getGoalLoopWorkItemSnapshot(db, {
				orgId: "org",
				objectiveId: "objective",
				outstandingPreviewLimit: 1,
			}),
		).toEqual({
			total: 3,
			doneCount: 1,
			outstandingCount: 2,
			outstandingIds: ["b"],
		});
	});

	it("derives readiness from the canonical dependency direction", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "blocker");
		seed(sqlite, "dependent");
		sqlite
			.prepare(
				"INSERT INTO work_item_relations VALUES ('rel','org','blocker','dependent','blocks','{}',?)",
			)
			.run(NOW);
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "dependent",
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: NOW,
				})
			).state,
		).toBe("dependencies_blocked");
		sqlite
			.prepare(
				"UPDATE work_items SET disposition='completed' WHERE id='blocker'",
			)
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "dependent",
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: NOW,
				})
			).state,
		).toBe("ready");
	});

	it("accepts the same uri as a distinct observation when a digest differs", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		const submit = (digest?: string) =>
			submitWorkItemEvidence(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				claimKey: "outcome",
				kind: "artifact",
				uri: "artifact://superseded",
				digest,
				submittedBy: { type: "tedi", id: "worker" },
				submittedAt: NOW,
			});
		const first = await submit();
		const second = await submit("sha256:corrected");
		expect(second.id).not.toBe(first.id);
	});

	it("fences evidence to the active attempt and closes it at completion", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		const evidence = await submitWorkItemEvidence(db, {
			orgId: "org",
			workItemId: "work",
			attemptId: attempt.id,
			claimKey: "outcome",
			kind: "artifact",
			uri: "artifact://result",
			submittedBy: { type: "tedi", id: "worker" },
			submittedAt: NOW,
		});
		expect(evidence.disposition).toBe("pending");
		await settleWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "succeeded",
			settledAt: NOW,
		});
		expect(
			(
				await completeWorkItem(db, {
					orgId: "org",
					workItemId: "work",
					actor: { type: "system", id: "review" },
					completedAt: NOW,
				})
			).disposition,
		).toBe("completed");

		await expect(
			submitWorkItemEvidence(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				claimKey: "outcome",
				kind: "artifact",
				uri: "artifact://stale",
				submittedBy: { type: "tedi", id: "worker" },
				submittedAt: NOW,
			}),
		).rejects.toBeInstanceOf(WorkFactoryError);
	});

	// Settled means done: completion counts no evidence and requires no review
	// (decisions/minimal-gates-over-pre-proof.md). A legacy item whose
	// stored contract still declares claims and a contract-less item both
	// complete through the same path, with or without any evidence rows.
	it("completes accepted work with no evidence, contract or not", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "legacy");
		seed(sqlite, "plain");
		sqlite
			.prepare(
				"UPDATE work_items SET acceptance_contract=NULL WHERE id='plain'",
			)
			.run();
		for (const workItemId of ["legacy", "plain"])
			expect(
				(
					await completeWorkItem(db, {
						orgId: "org",
						workItemId,
						actor: { type: "system", id: "review" },
						completedAt: NOW,
					})
				).disposition,
			).toBe("completed");
	});

	// A peer re-issuing complete must drain the item, not deadlock it.
	it("returns the settled row when completion is re-issued", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const first = await completeWorkItem(db, {
			orgId: "org",
			workItemId: "work",
			actor: { type: "system", id: "review" },
			completedAt: NOW,
		});
		const again = await completeWorkItem(db, {
			orgId: "org",
			workItemId: "work",
			actor: { type: "system", id: "review" },
			completedAt: "2026-08-20T12:05:00.000Z",
		});
		expect(again.disposition).toBe("completed");
		// Idempotent, not a second write: version and completion timestamp hold.
		expect(again.version).toBe(first.version);
		expect(again.completedAt).toBe(first.completedAt);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS total FROM work_events WHERE work_item_id='work' AND event_type='work.completed'",
				)
				.get(),
		).toEqual({ total: 1 });
	});

	it("atomically expires a timed-out attempt before acquiring its active slot", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const first = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-one",
			executor: { type: "tedi", id: "one" },
			expiresAt: "2026-08-20T11:00:00.000Z",
			startedAt: "2026-08-20T10:00:00.000Z",
		});
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: NOW,
				})
			).state,
		).toBe("ready");
		const second = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-two",
			executor: { type: "tedi", id: "two" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		expect(second.attempt.attemptNumber).toBe(2);
		expect(
			sqlite
				.prepare("SELECT runtime_state FROM work_attempts WHERE id=?")
				.get(first.attempt.id),
		).toEqual({ runtime_state: "expired" });
	});

	it("rejects settlement after authority expiry", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite
			.prepare(
				"UPDATE work_admissions SET expires_at='2026-08-20T11:00:00.000Z' WHERE id='admission-work-worker'",
			)
			.run();
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T11:00:00.000Z",
			startedAt: "2026-08-20T10:00:00.000Z",
		});
		await expect(
			settleWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				executor: { type: "tedi", id: "worker" },
				outcome: "succeeded",
				settledAt: NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
	});

	it("renews heartbeat expiry from a bounded server TTL", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		const renewed = await heartbeatWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			heartbeatAt: NOW,
			leaseTtlMs: 60_000,
		});
		expect(renewed.expiresAt).toBe("2026-08-20T12:01:00.000Z");
		await expect(
			heartbeatWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				executor: { type: "tedi", id: "worker" },
				heartbeatAt: NOW,
				leaseTtlMs: 100,
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
	});

	it("rejects an out-of-order heartbeat without shortening active authority", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: "2026-08-20T11:55:00.000Z",
		});
		const renewed = await heartbeatWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			heartbeatAt: NOW,
			leaseTtlMs: 60_000,
		});
		await expect(
			heartbeatWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				executor: { type: "tedi", id: "worker" },
				heartbeatAt: "2026-08-20T11:59:00.000Z",
				leaseTtlMs: 60_000,
			}),
		).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
		expect(
			sqlite
				.prepare(
					"SELECT heartbeat_at, expires_at, version FROM work_attempts WHERE id=?",
				)
				.get(attempt.id),
		).toEqual({
			heartbeat_at: renewed.heartbeatAt,
			expires_at: renewed.expiresAt,
			version: renewed.version,
		});
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: "2026-08-20T12:00:30.000Z",
				})
			).state,
		).toBe("already_running");
	});

	it("requires and immutably fences external session keys", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		await expect(
			startWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				admissionId: "admission-work-agent-final",
				executor: { type: "external_agent", id: "agent" },
				sessionId: "session",
				expiresAt: "2026-08-20T13:00:00.000Z",
				startedAt: NOW,
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
		const { attempt } = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-agent",
			executor: { type: "external_agent", id: "agent" },
			sessionId: "session",
			externalSessionKey: "external-key",
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		expect(attempt.externalSessionKey).toBe("external-key");
		await expect(
			heartbeatWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				attemptId: attempt.id,
				executor: { type: "external_agent", id: "agent" },
				sessionId: "session",
				externalSessionKey: "wrong",
				heartbeatAt: NOW,
				leaseTtlMs: 60_000,
			}),
		).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
	});

	it("rolls back attempt acquisition when its event insert fails", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite.exec(
			"CREATE TRIGGER reject_work_event BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT, 'event rejected'); END;",
		);
		await expect(
			startWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				admissionId: "admission-work-worker",
				executor: { type: "tedi", id: "worker" },
				expiresAt: "2026-08-20T13:00:00.000Z",
				startedAt: NOW,
			}),
		).rejects.toThrow("event rejected");
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_attempts").get(),
		).toEqual({ n: 0 });
	});

	it("rolls back evidence submission when its event insert fails", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite.exec(
			"CREATE TRIGGER reject_work_event BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT, 'event rejected'); END;",
		);
		await expect(
			submitWorkItemEvidence(db, {
				orgId: "org",
				workItemId: "work",
				claimKey: "outcome",
				kind: "artifact",
				uri: "artifact://atomic",
				submittedBy: { type: "system", id: "system" },
				submittedAt: NOW,
			}),
		).rejects.toThrow("event rejected");
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_evidence").get(),
		).toEqual({ n: 0 });
	});

	it("reads one evidence row only through its exact organization and Work identity", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		const evidence = await submitWorkItemEvidence(db, {
			orgId: "org",
			workItemId: "work",
			claimKey: "outcome",
			kind: "artifact",
			uri: "artifact://exact",
			submittedBy: { type: "system", id: "system" },
			submittedAt: NOW,
		});
		expect(
			await getWorkItemEvidence(db, {
				orgId: "org",
				workItemId: "work",
				evidenceId: evidence.id,
			}),
		).toMatchObject({ id: evidence.id });
		expect(
			await getWorkItemEvidence(db, {
				orgId: "other",
				workItemId: "work",
				evidenceId: evidence.id,
			}),
		).toBeNull();
		expect(
			await getWorkItemEvidence(db, {
				orgId: "org",
				workItemId: "other",
				evidenceId: evidence.id,
			}),
		).toBeNull();
	});

	it("rejects terminal disposition while an authoritative attempt is active", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "admission-work-worker",
			executor: { type: "tedi", id: "worker" },
			expiresAt: "2026-08-20T13:00:00.000Z",
			startedAt: NOW,
		});
		await expect(
			cancelWorkItem(db, {
				orgId: "org",
				workItemId: "work",
				actor: { type: "system", id: "operator" },
				cancelledAt: NOW,
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
		expect(
			sqlite
				.prepare("SELECT disposition FROM work_items WHERE id='work'")
				.get(),
		).toEqual({ disposition: "accepted" });
	});

	it("fails readiness closed for unevaluated budget and resources", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite.exec(
			`INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','work','browser',1,'${NOW}','${NOW}'); INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('budget','org','work_item','work',100,10,'USD','${NOW}')`,
		);
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("evaluation_required");
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					budgetAdmissible: false,
					resourcesAvailable: false,
					derivedAt: NOW,
				})
			).state,
		).toBe("resource_blocked");
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					budgetAdmissible: true,
					resourcesAvailable: false,
					derivedAt: NOW,
				})
			).state,
		).toBe("resource_blocked");
	});

	it("loads exact approval receipts while preserving unevaluated executor capability", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite
			.prepare(
				"UPDATE work_items SET required_capabilities='[\"browser\"]' WHERE id='work'",
			)
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("evaluation_required");
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					availableCapabilities: [],
					derivedAt: NOW,
				})
			).state,
		).toBe("capability_blocked");
		sqlite
			.prepare(
				"UPDATE work_items SET required_capabilities='[]',required_authorities='[\"deploy\"]' WHERE id='work'",
			)
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("approval_blocked");
		sqlite
			.prepare(
				"UPDATE work_items SET required_authorities='[]',risk_level='high' WHERE id='work'",
			)
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("approval_blocked");
	});

	it("accepts only current unexpired exact approval receipts in readiness", async () => {
		const { sqlite, db } = fixture();
		seed(sqlite, "work");
		sqlite.exec(`
			UPDATE work_items SET required_authorities='["deploy"]', risk_level='high' WHERE id='work';
			INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,version)
			VALUES ('stale','org','work',0,'deploy','admission','system','tedix','user','user','approved','stale','2026-08-20T13:00:00.000Z','2026-08-20T10:00:00.000Z',2),
			       ('expired','org','work',1,'risk:high','admission','system','tedix','user','user','approved','expired','2026-08-20T11:00:00.000Z','2026-08-20T10:00:00.000Z',2);
			INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at)
			VALUES ('stale-decision','stale',2,'approved','user','user','stale','2026-08-20T10:30:00.000Z'),
			       ('expired-decision','expired',2,'approved','user','user','expired','2026-08-20T10:30:00.000Z');
		`);
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("approval_blocked");
		sqlite.exec(`
			INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,version)
			VALUES ('deploy','org','work',1,'deploy','admission','system','tedix','user','user','approved','deploy','2026-08-20T13:00:00.000Z','2026-08-20T10:00:00.000Z',2),
			       ('risk','org','work',1,'risk:high','admission','system','tedix','user','user','approved','risk','2026-08-20T13:00:00.000Z','2026-08-20T10:00:00.000Z',2);
			INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at)
			VALUES ('deploy-decision','deploy',2,'approved','user','user','deploy','2026-08-20T10:30:00.000Z'),
			       ('risk-decision','risk',2,'approved','user','user','risk','2026-08-20T10:30:00.000Z');
		`);
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "work",
					derivedAt: NOW,
				})
			).state,
		).toBe("ready");
	});

	it("keyset-pages accepted readiness with a stable timestamp/id tie-break", async () => {
		const { sqlite, db } = fixture();
		for (let index = 0; index < 55; index++)
			seed(sqlite, `item-${index.toString().padStart(3, "0")}`);
		seed(sqlite, "proposed", "proposed");
		sqlite
			.prepare(
				`INSERT INTO work_items
				 (id,org_id,title,disposition,acceptance_contract,created_at,accepted_at)
				 VALUES ('other-org','other','Other','accepted',?, ?, ?)`,
			)
			.run(CONTRACT, NOW, NOW);

		const defaultPage = await listWorkItemReadinessProjection(db, {
			orgId: "org",
			observedAt: NOW,
		});
		expect(defaultPage.data).toHaveLength(25);
		expect(defaultPage.nextCursor).toEqual({
			createdAt: NOW,
			id: "item-030",
		});

		const first = await listWorkItemReadinessProjection(db, {
			orgId: "org",
			limit: 999,
			observedAt: NOW,
		});
		expect(first.data).toHaveLength(50);
		expect(first.hasMore).toBe(true);
		expect(first.data[0]?.workItem.id).toBe("item-054");
		expect(first.nextCursor).toEqual({ createdAt: NOW, id: "item-005" });
		expect(first.data.every((row) => row.readiness.gates.length === 9)).toBe(
			true,
		);
		expect(first.data[0]?.readiness.state).toBe("ready");

		const second = await listWorkItemReadinessProjection(db, {
			orgId: "org",
			cursor: first.nextCursor!,
			limit: 50,
			observedAt: NOW,
		});
		expect(second.data.map((row) => row.workItem.id)).toEqual([
			"item-004",
			"item-003",
			"item-002",
			"item-001",
			"item-000",
		]);
		expect(second.nextCursor).toBeNull();
		expect(second.hasMore).toBe(false);
		expect(
			new Set([...first.data, ...second.data].map((row) => row.workItem.id))
				.size,
		).toBe(55);
	});

	it("matches scalar context-free readiness for every bulk-owned fact", async () => {
		const { sqlite, db } = fixture();
		for (const id of [
			"ready",
			"capability",
			"risk",
			"blocked",
			"resource",
			"budget-org",
			"budget-project",
			"budget-case",
			"running",
			"expired",
		])
			seed(sqlite, id);
		sqlite
			.prepare(
				"UPDATE work_items SET required_capabilities='[\"repo\"]' WHERE id='capability'",
			)
			.run();
		sqlite
			.prepare("UPDATE work_items SET risk_level='high' WHERE id='risk'")
			.run();
		sqlite
			.prepare(
				"UPDATE work_items SET project_id='project' WHERE id='budget-project'",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO work_item_relations VALUES ('rel-projection','org','ready','blocked','blocks','{}',?)",
			)
			.run(NOW);
		sqlite
			.prepare(
				"INSERT INTO work_resource_requirements VALUES ('org','resource','browser',1,?,?)",
			)
			.run(NOW, NOW);
		for (const [id, scopeType, scopeId] of [
			["envelope-org", "organization", "org"],
			["envelope-project", "project", "project"],
			["envelope-case", "case", "case"],
		] as const)
			sqlite
				.prepare(
					"INSERT INTO work_budget_envelopes (id,org_id,scope_type,scope_id,limit_micros,reservation_micros,created_at) VALUES (?,'org',?,?,100,10,?)",
				)
				.run(id, scopeType, scopeId, NOW);
		sqlite
			.prepare(
				"INSERT INTO work_case_items VALUES ('case-link','org','case','budget-case',?,NULL)",
			)
			.run(NOW);
		for (const [id, itemId, expiresAt] of [
			["attempt-running", "running", "2026-08-20T13:00:00.000Z"],
			["attempt-expired", "expired", "2026-08-20T11:00:00.000Z"],
		] as const)
			sqlite
				.prepare(
					"INSERT INTO work_attempts (id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at,metadata) VALUES (?,?,'org','tedi','worker','running',1,?,?,?,'{}')",
				)
				.run(id, itemId, NOW, NOW, expiresAt);

		const projection = await listWorkItemReadinessProjection(db, {
			orgId: "org",
			limit: 50,
			observedAt: NOW,
		});
		const byId = new Map(
			projection.data.map((row) => [row.workItem.id, row.readiness]),
		);
		for (const itemId of byId.keys())
			expect(byId.get(itemId)).toEqual(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: itemId,
					derivedAt: NOW,
				}),
			);
		expect(byId.get("ready")?.state).toBe("evaluation_required");
		expect(byId.get("capability")?.state).toBe("evaluation_required");
		expect(byId.get("risk")?.state).toBe("approval_blocked");
		expect(byId.get("blocked")?.state).toBe("dependencies_blocked");
		expect(byId.get("resource")?.state).toBe("evaluation_required");
		expect(byId.get("budget-org")?.state).toBe("evaluation_required");
		expect(byId.get("budget-project")?.state).toBe("evaluation_required");
		expect(byId.get("budget-case")?.state).toBe("evaluation_required");
		expect(byId.get("running")?.state).toBe("already_running");
		expect(byId.get("expired")?.state).toBe("evaluation_required");
		expect(
			projection.data.every((row) => row.readiness.derivedAt === NOW),
		).toBe(true);
	});
});
