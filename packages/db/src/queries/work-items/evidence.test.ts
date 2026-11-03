import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	recordRepositoryCandidatePublicationObservation,
	getRepositoryCandidatePublicationEffect,
	submitWorkItemEvidence,
} from "./evidence";
import type {
	RepositoryCandidatePreparation,
	RepositoryCandidatePublicationObservation,
} from "@tedix/api-contract/schemas/repository-candidate";
const id = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222",
	admissionId = "33333333-3333-4333-8333-333333333333",
	now = "2026-10-01T00:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE work_attempts(id TEXT PRIMARY KEY,work_item_id TEXT,org_id TEXT,runtime_state TEXT,metadata TEXT);
 CREATE TABLE work_evidence(id TEXT PRIMARY KEY,work_item_id TEXT,org_id TEXT,attempt_id TEXT,claim_key TEXT,kind TEXT,uri TEXT,digest TEXT,media_type TEXT,label TEXT,submitted_by_type TEXT,submitted_by_id TEXT,submitted_by_session_id TEXT,disposition TEXT,reviewed_by_type TEXT,reviewed_by_id TEXT,reviewed_by_session_id TEXT,review_reason TEXT,submitted_at TEXT,reviewed_at TEXT,version INTEGER,metadata TEXT);
 CREATE UNIQUE INDEX uniq_work_evidence_observation ON work_evidence(org_id,work_item_id,claim_key,uri,coalesce(digest,''));
 CREATE TABLE work_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,org_id TEXT,work_item_id TEXT,attempt_id TEXT,event_type TEXT,actor_type TEXT,actor_id TEXT,actor_session_id TEXT,payload TEXT,occurred_at TEXT);`);
	const person = {
		name: "Fixture",
		email: "fixture@example.invalid",
		timestamp: 0,
		timezoneOffset: 0,
	};
	const preparation: RepositoryCandidatePreparation = {
		version: 1,
		descriptor: {
			version: 1,
			organizationId: "org",
			workItemId: id,
			attemptId,
			admissionId,
			repositoryId: "repo",
			repositoryName: "fixture",
			baseRevision: "a".repeat(40),
			files: [{ path: "file.ts", blobRevision: "b".repeat(40), bytes: 1 }],
			selectionDigest: "c".repeat(64),
			roomName: "room",
			docKey: "doc",
			createdAt: now,
		},
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
		preparedAt: now,
		preparationDigest: "2".repeat(64),
	};
	const metadata = JSON.stringify({
		repositoryCandidatePublication: { preparation, attemptedAt: now },
	});
	sqlite
		.prepare("INSERT INTO work_attempts VALUES (?,?,'org','expired',?)")
		.run(attemptId, id, metadata);
	const observation: RepositoryCandidatePublicationObservation = {
		effect: "acknowledged",
		headRevision: preparation.commitRevision,
		objectPresent: true,
		superseded: false,
		cleanup: "revoked",
		observedAt: now,
	};
	const observedBy = {
		type: "external_agent" as const,
		id: "reader",
		sessionId: "fresh-session",
		userId: "owner",
	};
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite)),
		preparation,
		observation,
		observedBy,
		metadata,
	};
}
describe("server-derived historical publication facts", () => {
	it("appends deduplicated observations after expiry without mutating or attaching an active Attempt", async () => {
		const f = fixture(),
			first = await recordRepositoryCandidatePublicationObservation(f.db, f),
			second = await recordRepositoryCandidatePublicationObservation(f.db, {
				...f,
				observation: {
					...f.observation,
					observedAt: "2026-10-02T00:00:00.000Z",
				},
			});
		expect(first.id).toBe(second.id);
		expect(first.attemptId).toBeNull();
		expect(first.metadata).toMatchObject({
			originalAttemptId: attemptId,
			observedBy: f.observedBy,
		});
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM work_events").get(),
		).toEqual({ n: 1 });
		expect(
			f.sqlite.prepare("SELECT metadata FROM work_attempts").get(),
		).toEqual({ metadata: f.metadata });
	});
	it.each(["reserved kind", "reserved claim prefix"])(
		"rejects public %s poisoning even with otherwise ordinary actor metadata",
		async (kind) => {
			const f = fixture();
			await expect(
				submitWorkItemEvidence(f.db, {
					orgId: "org",
					workItemId: id,
					claimKey:
						kind === "reserved claim prefix"
							? `repository_candidate_publication:${attemptId}:forged`
							: "ordinary",
					kind:
						kind === "reserved kind"
							? "repository_candidate_publication"
							: "log",
					uri: "artifacts:fixture",
					submittedBy: { type: "user", id: "owner" },
				}),
			).rejects.toThrow(/server-derived/);
		},
	);
	it("retains ACK priority after more than 100 observed facts", async () => {
		const f = fixture();
		for (let i = 0; i < 105; i++)
			await recordRepositoryCandidatePublicationObservation(f.db, {
				...f,
				observation: {
					...f.observation,
					effect: "observed",
					headRevision: i.toString(16).padStart(40, "0"),
				},
			});
		await recordRepositoryCandidatePublicationObservation(f.db, f);
		expect(
			await getRepositoryCandidatePublicationEffect(f.db, f.preparation),
		).toBe("acknowledged");
	});
	it("cannot append facts to a different preparation", async () => {
		const f = fixture();
		await expect(
			recordRepositoryCandidatePublicationObservation(f.db, {
				...f,
				preparation: { ...f.preparation, preparationDigest: "9".repeat(64) },
			}),
		).rejects.toThrow(/unavailable/);
	});
});
