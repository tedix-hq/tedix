import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { closeTerminalLeaseBundles } from "./workstations";

const NOW = "2026-08-05T12:00:00.000Z";
const LEASE_ENDED = "2026-08-01T09:00:00.000Z";

const DDL = `
CREATE TABLE workstations (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT,
	profile_id TEXT NOT NULL DEFAULT 'general',
	status TEXT NOT NULL,
	seats TEXT NOT NULL DEFAULT '[]',
	capabilities TEXT NOT NULL DEFAULT '[]',
	adapters TEXT NOT NULL DEFAULT '[]',
	artifact_refs TEXT NOT NULL DEFAULT '[]',
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE workstation_leases (
	id TEXT PRIMARY KEY NOT NULL,
	workstation_id TEXT NOT NULL,
	org_id TEXT,
	profile_id TEXT NOT NULL DEFAULT 'general',
	status TEXT NOT NULL,
	work_item_id TEXT,
	kernel_run_id TEXT,
	trace_bundle_id TEXT,
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	expires_at TEXT,
	released_at TEXT
);
CREATE TABLE workstation_participants (
	id TEXT PRIMARY KEY NOT NULL,
	lease_id TEXT NOT NULL,
	org_id TEXT,
	tedi_id TEXT NOT NULL,
	slug TEXT,
	role TEXT NOT NULL,
	status TEXT NOT NULL,
	permission_scopes TEXT NOT NULL DEFAULT '[]',
	joined_at TEXT NOT NULL,
	left_at TEXT,
	metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE workstation_sessions (
	id TEXT PRIMARY KEY NOT NULL,
	lease_id TEXT NOT NULL,
	org_id TEXT,
	participant_id TEXT,
	kind TEXT NOT NULL DEFAULT 'exec',
	adapter TEXT NOT NULL DEFAULT 'sandbox',
	status TEXT NOT NULL,
	session_key TEXT,
	external_id TEXT,
	artifact_refs TEXT NOT NULL DEFAULT '[]',
	started_at TEXT NOT NULL,
	ended_at TEXT,
	metadata TEXT NOT NULL DEFAULT '{}'
);
`;

function seed(options: {
	leaseStatus: string;
	workstationStatus?: string;
	participantStatuses?: string[];
	sessions?: { status: string; endedAt?: string }[];
	expiresAt?: string | null;
	releasedAt?: string | null;
}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite.exec(
		`INSERT INTO workstations (id, org_id, status, created_at, updated_at)
		 VALUES ('ws-1', 'org-1', '${options.workstationStatus ?? "ready"}', '${LEASE_ENDED}', '${LEASE_ENDED}')`,
	);
	const expires =
		options.expiresAt === undefined
			? `'${LEASE_ENDED}'`
			: options.expiresAt === null
				? "NULL"
				: `'${options.expiresAt}'`;
	const released =
		options.releasedAt === undefined || options.releasedAt === null
			? "NULL"
			: `'${options.releasedAt}'`;
	sqlite.exec(
		`INSERT INTO workstation_leases
		   (id, workstation_id, org_id, status, created_at, updated_at, expires_at, released_at)
		 VALUES ('lease-1', 'ws-1', 'org-1', '${options.leaseStatus}',
		         '2026-07-30T00:00:00.000Z', '${LEASE_ENDED}', ${expires}, ${released})`,
	);
	(options.participantStatuses ?? ["active"]).forEach((status, index) => {
		sqlite.exec(
			`INSERT INTO workstation_participants
			   (id, lease_id, org_id, tedi_id, role, status, joined_at)
			 VALUES ('p-${index}', 'lease-1', 'org-1', 'tedi-${index}', 'lead', '${status}', '${LEASE_ENDED}')`,
		);
	});
	(options.sessions ?? [{ status: "ready" }]).forEach((session, index) => {
		sqlite.exec(
			`INSERT INTO workstation_sessions
			   (id, lease_id, org_id, status, started_at, ended_at)
			 VALUES ('s-${index}', 'lease-1', 'org-1', '${session.status}', '${LEASE_ENDED}',
			         ${session.endedAt ? `'${session.endedAt}'` : "NULL"})`,
		);
	});
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const rows = (sqlite: DatabaseSync, query: string) =>
	sqlite.prepare(query).all() as Record<string, unknown>[];

describe("closeTerminalLeaseBundles", () => {
	it("closes participants, sessions, and the workstation of an expired lease", async () => {
		// The production shape the reaper left behind: the lease reached a
		// terminal state and every child it owned stayed open.
		const { db, sqlite } = seed({
			leaseStatus: "expired",
			participantStatuses: ["active", "active"],
			sessions: [{ status: "ready" }, { status: "blocked" }],
		});

		const closed = await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({
			leaseId: "lease-1",
			participants: 2,
			sessions: 2,
			workstationArchived: true,
		});
		expect(
			rows(sqlite, "SELECT status FROM workstation_participants").every(
				(row) => row.status === "left",
			),
		).toBe(true);
		expect(
			rows(sqlite, "SELECT status FROM workstation_sessions").every(
				(row) => row.status === "archived",
			),
		).toBe(true);
		expect(rows(sqlite, "SELECT status FROM workstations")[0]?.status).toBe(
			"archived",
		);
	});

	it("stamps the LEASE's terminal time, not the time the sweep happened to run", async () => {
		// Dating a session that stopped days ago to today would inflate every
		// duration derived from it — the wall-clock mistake that already made
		// container cost unusable once.
		const { db, sqlite } = seed({ leaseStatus: "expired" });

		await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(
			rows(sqlite, "SELECT ended_at FROM workstation_sessions")[0],
		).toEqual({ ended_at: LEASE_ENDED });
		expect(
			rows(sqlite, "SELECT left_at FROM workstation_participants")[0],
		).toEqual({ left_at: LEASE_ENDED });
	});

	it("prefers released_at over expires_at when a lease was released properly", async () => {
		const releasedAt = "2026-08-02T15:30:00.000Z";
		const { db, sqlite } = seed({ leaseStatus: "released", releasedAt });

		await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(
			rows(sqlite, "SELECT ended_at FROM workstation_sessions")[0],
		).toEqual({ ended_at: releasedAt });
	});

	it("keeps an end time a session already recorded", async () => {
		const realEnd = "2026-07-31T08:00:00.000Z";
		const { db, sqlite } = seed({
			leaseStatus: "expired",
			sessions: [{ endedAt: realEnd, status: "ready" }],
		});

		await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(
			rows(sqlite, "SELECT ended_at FROM workstation_sessions")[0],
		).toEqual({ ended_at: realEnd });
	});

	it("never touches a lease that is still live", async () => {
		// A running workstation's participants and sessions are legitimately
		// open. Closing them would evict an active coding session.
		const { db, sqlite } = seed({ leaseStatus: "active" });

		const closed = await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(closed).toEqual([]);
		expect(
			rows(sqlite, "SELECT status FROM workstation_participants")[0],
		).toEqual({ status: "active" });
		expect(rows(sqlite, "SELECT status FROM workstations")[0]).toEqual({
			status: "ready",
		});
	});

	it("is a no-op once the bundle is already closed", async () => {
		// Re-running must not re-report work or move an end time. The sweep runs
		// every 15 minutes against a table where most bundles are settled.
		const { db } = seed({
			leaseStatus: "released",
			participantStatuses: ["left"],
			releasedAt: LEASE_ENDED,
			sessions: [{ endedAt: LEASE_ENDED, status: "archived" }],
			workstationStatus: "archived",
		});

		expect(
			await closeTerminalLeaseBundles(db, { limit: 10, now: NOW }),
		).toEqual([]);
	});

	it("still closes children when only the workstation is already archived", async () => {
		// Partial closure is the state a half-finished release leaves. The sweep
		// has to converge from it, not skip it because one predicate is clean.
		const { db, sqlite } = seed({
			leaseStatus: "expired",
			workstationStatus: "archived",
		});

		const closed = await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(closed[0]).toMatchObject({
			participants: 1,
			sessions: 1,
			workstationArchived: false,
		});
		expect(rows(sqlite, "SELECT status FROM workstation_sessions")[0]).toEqual({
			status: "archived",
		});
	});

	it("falls back to updated_at when a terminal lease carries neither timestamp", async () => {
		const { db, sqlite } = seed({ expiresAt: null, leaseStatus: "expired" });

		await closeTerminalLeaseBundles(db, { limit: 10, now: NOW });

		expect(
			rows(sqlite, "SELECT ended_at FROM workstation_sessions")[0],
		).toEqual({ ended_at: LEASE_ENDED });
	});
});
