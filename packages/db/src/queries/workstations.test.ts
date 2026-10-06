import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import type { DbClient } from "../client";
import type {
	WorkstationLeaseRow,
	WorkstationParticipantRow,
} from "../schema/workstations";
import {
	appendParticipantsToLeaseBundle,
	bindWorkstationLeaseRepositoryAuthority,
	getWorkstationInspectionAuthority,
	getWorkstationReadinessByTedi,
	releaseWorkstationLeaseBundle,
	upsertWorkstationLeaseBundle,
	type WorkstationLeaseRowBundle,
} from "./workstations";

function fkFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`PRAGMA foreign_keys=ON;
	CREATE TABLE workstations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, org_id TEXT, status TEXT NOT NULL, seats TEXT NOT NULL, capabilities TEXT NOT NULL, adapters TEXT NOT NULL, artifact_refs TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
	CREATE TABLE workstation_leases (id TEXT PRIMARY KEY, workstation_id TEXT NOT NULL REFERENCES workstations(id), profile_id TEXT NOT NULL, org_id TEXT, work_item_id TEXT, attempt_id TEXT, repository_path TEXT, repo_start_sha TEXT, prepared_start_sha TEXT, kernel_run_id TEXT, trace_bundle_id TEXT, status TEXT NOT NULL, capabilities TEXT NOT NULL, adapters TEXT NOT NULL, approval_ids TEXT NOT NULL, artifact_refs TEXT NOT NULL, metadata TEXT NOT NULL, body_generation_id TEXT, body_generation_kind TEXT, body_generation_status TEXT, body_generation_token_hash TEXT, body_generation_token_expires_at TEXT, body_generation_external_id TEXT, body_generation_heartbeat_at TEXT, body_instance_id TEXT, body_instance_name TEXT, body_instance_observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT, released_at TEXT);
	CREATE TABLE workstation_participants (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES workstation_leases(id), org_id TEXT, tedi_id TEXT NOT NULL, slug TEXT, role TEXT NOT NULL, status TEXT NOT NULL, permission_scopes TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, metadata TEXT NOT NULL);
	CREATE TABLE workstation_sessions (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES workstation_leases(id), org_id TEXT, participant_id TEXT, kind TEXT NOT NULL, adapter TEXT NOT NULL, status TEXT NOT NULL, session_key TEXT, external_id TEXT, artifact_refs TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL);`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function leadParticipant(): WorkstationParticipantRow {
	return {
		id: "wl_general_org-tedix_cto_participant_cto",
		leaseId: "wl_general_org-tedix_cto",
		orgId: "org_tedix",
		tediId: "tedi-cto",
		slug: "cto",
		role: "lead",
		status: "active",
		permissionScopes: [],
		joinedAt: "2026-06-14T12:00:00.000Z",
		leftAt: null,
		metadata: { seatIndex: 0 },
	};
}

function leaseBundle(
	participants: WorkstationParticipantRow[],
): WorkstationLeaseRowBundle {
	const lease: WorkstationLeaseRow = {
		id: "wl_general_org-tedix_cto",
		workstationId: "ws_general_org-tedix_cto",
		profileId: "general",
		orgId: "org_tedix",
		workItemId: null,
		attemptId: null,
		repositoryPath: null,
		repoStartSha: null,
		preparedStartSha: null,
		kernelRunId: "kernel-run-1",
		traceBundleId: null,
		status: "active",
		capabilities: ["repo", "shell"],
		adapters: ["sandbox-workstation"],
		approvalIds: [],
		artifactRefs: [],
		createdAt: "2026-06-14T12:00:00.000Z",
		updatedAt: "2026-06-14T12:00:00.000Z",
		expiresAt: null,
		releasedAt: null,
		metadata: {},
		bodyGenerationId: null,
		bodyGenerationKind: null,
		bodyGenerationStatus: null,
		bodyGenerationTokenHash: null,
		bodyGenerationTokenExpiresAt: null,
		bodyGenerationExternalId: null,
		bodyGenerationHeartbeatAt: null,
	};
	return {
		workstation: {
			id: "ws_general_org-tedix_cto",
			profileId: "general",
			orgId: "org_tedix",
			status: "ready",
			seats: [{ role: "lead", slug: "cto", tediId: "tedi-cto" }],
			capabilities: ["repo", "shell"],
			adapters: ["sandbox-workstation"],
			artifactRefs: [],
			metadata: {},
			createdAt: "2026-06-14T12:00:00.000Z",
			updatedAt: "2026-06-14T12:00:00.000Z",
		},
		workstationLease: { ...lease, participants, sessions: [] },
	};
}

describe("workstation lease owner fence", () => {
	it("creates the FK parent atomically and rejects owner tuple overwrite", async () => {
		const { db, sqlite } = fkFixture();
		const original = leaseBundle([]);
		original.workstationLease.workItemId = "work-1";
		original.workstationLease.attemptId = "attempt-1";
		await expect(upsertWorkstationLeaseBundle(db, original)).resolves.toBe(
			original,
		);
		expect(
			sqlite.prepare("SELECT workstation_id FROM workstation_leases").get(),
		).toEqual({ workstation_id: original.workstation.id });

		const hostile = structuredClone(original);
		hostile.workstationLease.attemptId = "attempt-2";
		hostile.workstation.metadata = { overwritten: true };
		await expect(upsertWorkstationLeaseBundle(db, hostile)).rejects.toThrow(
			"owner authority changed",
		);
		expect(
			JSON.parse(
				sqlite.prepare("SELECT metadata FROM workstations").get()!
					.metadata as string,
			),
		).toEqual({});
	});

	it("rejects cross-org parent reuse and immutable lease-parent changes", async () => {
		const { db } = fkFixture();
		const original = leaseBundle([]);
		original.workstationLease.workItemId = "work-1";
		original.workstationLease.attemptId = "attempt-1";
		await upsertWorkstationLeaseBundle(db, original);
		const hostile = structuredClone(original);
		hostile.workstation.orgId = "org-2";
		hostile.workstationLease.orgId = "org-2";
		await expect(upsertWorkstationLeaseBundle(db, hostile)).rejects.toThrow();
		const moved = structuredClone(original);
		moved.workstation.id = "ws-other";
		moved.workstationLease.workstationId = "ws-other";
		await expect(upsertWorkstationLeaseBundle(db, moved)).rejects.toThrow(
			"owner authority changed",
		);
	});

	it("binds a provisioning baseline once and exposes it only after activation", async () => {
		const { db, sqlite } = fkFixture();
		const original = leaseBundle([]);
		original.workstationLease.participants = [leadParticipant()];
		original.workstationLease.workItemId = "work-1";
		original.workstationLease.attemptId = "attempt-1";
		original.workstationLease.bodyGenerationId = "generation-1";
		original.workstationLease.status = "provisioning";
		await upsertWorkstationLeaseBundle(db, original);
		sqlite
			.prepare(
				"UPDATE workstation_leases SET body_generation_id = ? WHERE id = ?",
			)
			.run("generation-1", original.workstationLease.id);
		const input = {
			leaseId: original.workstationLease.id,
			orgId: "org_tedix",
			workItemId: "work-1",
			attemptId: "attempt-1",
			generationId: "generation-1",
			repositoryPath: "tedix/tedix",
			repoStartSha: "a".repeat(40),
			preparedStartSha: "a".repeat(40),
		};
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, input),
		).resolves.toMatchObject({ repositoryPath: "tedix/tedix" });
		await expect(
			getWorkstationInspectionAuthority(db, {
				orgId: "org_tedix",
				workItemId: "work-1",
				attemptId: "attempt-1",
				tediId: "tedi-cto",
			}),
		).resolves.toBeNull();
		sqlite
			.prepare(
				"UPDATE workstation_leases SET status = ?, body_instance_name = ? WHERE id = ?",
			)
			.run("active", "body-1", input.leaseId);
		await expect(
			getWorkstationInspectionAuthority(db, {
				orgId: "org_tedix",
				workItemId: "work-1",
				attemptId: "attempt-1",
				tediId: "tedi-cto",
			}),
		).resolves.toMatchObject({
			workstationLease: {
				preparedStartSha: "a".repeat(40),
				repositoryPath: "tedix/tedix",
			},
		});
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, {
				...input,
				repoStartSha: "b".repeat(40),
			}),
		).rejects.toThrow();
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, {
				...input,
				orgId: "org-other",
			}),
		).rejects.toThrow();
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, {
				...input,
				attemptId: "attempt-other",
			}),
		).rejects.toThrow();
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, {
				...input,
				generationId: "stale",
			}),
		).rejects.toThrow();
		sqlite
			.prepare("UPDATE workstation_leases SET expires_at = ? WHERE id = ?")
			.run("2020-01-01T00:00:00.000Z", input.leaseId);
		await expect(
			bindWorkstationLeaseRepositoryAuthority(db, input),
		).rejects.toThrow();
	});
});

describe("appendParticipantsToLeaseBundle", () => {
	it("appends new participant seats and stamps stable ids", () => {
		const { bundle, added } = appendParticipantsToLeaseBundle(
			leaseBundle([leadParticipant()]),
			[
				{
					tediId: "tedi-devops",
					role: "specialist",
					slug: "devops",
					permissionScopes: ["deploy"],
				},
			],
			{
				joinContext: {
					joinedBySlug: "cto",
					joinedByTediId: "tedi-cto",
					kernelRunId: "kernel-run-join",
					traceBundleId: "trace-bundle-join",
					traceId: "trace-join",
					workItemId: "work-item-join",
				},
				now: "2026-06-14T13:00:00.000Z",
			},
		);

		expect(added).toEqual(["tedi-devops"]);
		expect(bundle.workstation.seats).toEqual([
			{ permissionScopes: [], role: "lead", slug: "cto", tediId: "tedi-cto" },
			{
				permissionScopes: ["deploy"],
				role: "specialist",
				slug: "devops",
				tediId: "tedi-devops",
			},
		]);
		expect(bundle.workstationLease.participants).toHaveLength(2);
		expect(bundle.workstationLease.metadata.collaborationMode).toBe(
			"collaborative",
		);
		const appended = bundle.workstationLease.participants[1];
		expect(appended).toMatchObject({
			id: "wl_general_org-tedix_cto_participant_devops",
			leaseId: "wl_general_org-tedix_cto",
			orgId: "org_tedix",
			tediId: "tedi-devops",
			slug: "devops",
			role: "specialist",
			status: "active",
			permissionScopes: ["deploy"],
			joinedAt: "2026-06-14T13:00:00.000Z",
			metadata: {
				joinedBySlug: "cto",
				joinedByTediId: "tedi-cto",
				kernelRunId: "kernel-run-join",
				seatIndex: 1,
				traceBundleId: "trace-bundle-join",
				traceId: "trace-join",
				workItemId: "work-item-join",
			},
		});
		expect(bundle.workstationLease.updatedAt).toBe("2026-06-14T13:00:00.000Z");
		expect(bundle.workstationLease.metadata).toMatchObject({
			lastParticipantJoin: {
				addedTediIds: ["tedi-devops"],
				joinedBySlug: "cto",
				joinedByTediId: "tedi-cto",
				joinedAt: "2026-06-14T13:00:00.000Z",
				kernelRunId: "kernel-run-join",
				requestedTediIds: ["tedi-devops"],
				traceBundleId: "trace-bundle-join",
				traceId: "trace-join",
				workItemId: "work-item-join",
			},
		});
	});

	it("is idempotent on tediId — an already-seated tedi is not duplicated", () => {
		const original = leaseBundle([leadParticipant()]);
		const { bundle, added } = appendParticipantsToLeaseBundle(
			original,
			[
				// Lead is already seated → skipped.
				{ tediId: "tedi-cto", role: "collaborator", slug: "cto" },
				// New seat → added.
				{ tediId: "tedi-devops", role: "specialist", slug: "devops" },
				// Same new seat repeated in one call → added once.
				{ tediId: "tedi-devops", role: "collaborator" },
			],
			{ now: "2026-06-14T13:00:00.000Z" },
		);

		expect(added).toEqual(["tedi-devops"]);
		expect(bundle.workstationLease.participants.map((p) => p.tediId)).toEqual([
			"tedi-cto",
			"tedi-devops",
		]);
		// Lead row is untouched (role stays "lead", not downgraded).
		expect(bundle.workstationLease.participants[0]?.role).toBe("lead");
	});

	it("returns the original bundle unchanged when every seat is already present", () => {
		const original = leaseBundle([leadParticipant()]);
		const { bundle, added } = appendParticipantsToLeaseBundle(original, [
			{ tediId: "tedi-cto" },
		]);

		expect(added).toEqual([]);
		expect(bundle).toBe(original);
	});
});

describe("releaseWorkstationLeaseBundle", () => {
	it("closes the lease, participants, and sessions with release evidence", () => {
		const original = leaseBundle([leadParticipant()]);
		original.workstationLease.sessions = [
			{
				adapter: "sandbox-workstation",
				artifactRefs: [],
				endedAt: null,
				externalId: null,
				id: "session-shell",
				kind: "shell",
				leaseId: original.workstationLease.id,
				metadata: {},
				orgId: "org_tedix",
				participantId: leadParticipant().id,
				sessionKey: "tedi-cto:shell",
				startedAt: "2026-06-14T12:00:00.000Z",
				status: "ready",
			},
		];
		const released = releaseWorkstationLeaseBundle(
			original,
			{
				reason: "proof complete",
				releasedBySlug: "cto",
				releasedByTediId: "tedi-cto",
				traceId: "trace-release",
			},
			"2026-06-14T14:00:00.000Z",
		);

		expect(released.workstation.status).toBe("archived");
		expect(released.workstationLease).toMatchObject({
			releasedAt: "2026-06-14T14:00:00.000Z",
			status: "released",
			participants: [{ leftAt: "2026-06-14T14:00:00.000Z", status: "left" }],
			sessions: [{ endedAt: "2026-06-14T14:00:00.000Z", status: "archived" }],
		});
		expect(released.workstationLease.metadata.lastRelease).toEqual({
			reason: "proof complete",
			releasedAt: "2026-06-14T14:00:00.000Z",
			releasedBySlug: "cto",
			releasedByTediId: "tedi-cto",
			traceId: "trace-release",
		});
	});
});

/**
 * Minimal two-select drizzle double: the query does
 * `select().from(leases).where()` then `select().from(participants).where()`.
 * Each terminal `.where()` resolves to the next queued result.
 */
function makeReadinessDb(
	leaseRows: unknown[],
	participantRows: unknown[],
): DbClient {
	const queue = [leaseRows, participantRows];
	const node = {
		select: () => node,
		from: () => node,
		where: () => Promise.resolve(queue.shift() ?? []),
	};
	return node as unknown as DbClient;
}

describe("getWorkstationReadinessByTedi", () => {
	it("projects depsReady/environmentReady from an active lease's metadata", async () => {
		const db = makeReadinessDb(
			[
				{
					id: "lease-1",
					status: "active",
					metadata: {
						environmentReady: true,
						depsReady: true,
						installStatus: "ready",
					},
				},
			],
			[{ tediId: "tedi-cto", status: "active", leaseId: "lease-1" }],
		);
		const map = await getWorkstationReadinessByTedi(db, "org_tedix");
		expect(map.get("tedi-cto")).toEqual({
			leaseStatus: "active",
			environmentReady: true,
			depsReady: true,
			installStatus: "ready",
		});
	});

	it("marks a degraded (deps-installing) lease as not environment-ready", async () => {
		const db = makeReadinessDb(
			[
				{
					id: "lease-1",
					status: "degraded",
					metadata: {
						environmentReady: false,
						depsReady: false,
						installStatus: "running",
					},
				},
			],
			[{ tediId: "tedi-cto", status: "active", leaseId: "lease-1" }],
		);
		const map = await getWorkstationReadinessByTedi(db, "org_tedix");
		expect(map.get("tedi-cto")).toMatchObject({
			depsReady: false,
			environmentReady: false,
			installStatus: "running",
		});
	});

	it("defaults to not-ready (fail-safe) when metadata is absent", async () => {
		const db = makeReadinessDb(
			[{ id: "lease-1", status: "provisioning", metadata: null }],
			[{ tediId: "tedi-cto", status: "active", leaseId: "lease-1" }],
		);
		const map = await getWorkstationReadinessByTedi(db, "org_tedix");
		expect(map.get("tedi-cto")).toMatchObject({
			depsReady: false,
			environmentReady: false,
			installStatus: null,
		});
	});

	it("reads readiness from a nested bootstrapReadiness object too", async () => {
		const db = makeReadinessDb(
			[
				{
					id: "lease-1",
					status: "active",
					metadata: {
						bootstrapReadiness: { depsReady: true, environmentReady: true },
					},
				},
			],
			[{ tediId: "tedi-cto", status: "active", leaseId: "lease-1" }],
		);
		const map = await getWorkstationReadinessByTedi(db, "org_tedix");
		expect(map.get("tedi-cto")).toMatchObject({
			depsReady: true,
			environmentReady: true,
		});
	});

	it("ignores departed participants and returns an empty map with no warm leases", async () => {
		const empty = await getWorkstationReadinessByTedi(
			makeReadinessDb([], []),
			"org_tedix",
		);
		expect(empty.size).toBe(0);

		const departed = await getWorkstationReadinessByTedi(
			makeReadinessDb(
				[{ id: "lease-1", status: "active", metadata: { depsReady: true } }],
				[{ tediId: "tedi-cto", status: "left", leaseId: "lease-1" }],
			),
			"org_tedix",
		);
		expect(departed.has("tedi-cto")).toBe(false);
	});
});
