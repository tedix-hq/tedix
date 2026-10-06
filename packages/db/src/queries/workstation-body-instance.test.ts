/**
 * The lease-to-container join, and the predicate that decides what may be
 * stopped.
 *
 * Production had 9 Running container instances for one tedi against 5
 * non-terminal leases and no way to map one to the other, so nothing could be
 * reaped. These tests pin the two properties that make reaping decidable: the
 * instance identity is RECORDED on the lease, and a body is only reapable when
 * every lease naming it is terminal.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	listReapableWorkstationBodies,
	recordWorkstationLeaseBodyInstance,
} from "./workstations";

const DDL = `
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
	body_instance_id TEXT,
	body_instance_name TEXT,
	body_instance_observed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	expires_at TEXT,
	released_at TEXT
);
`;

interface LeaseSeed {
	id: string;
	status: string;
	instanceName?: string;
	instanceId?: string;
	observedAt?: string;
}

function seed(leases: LeaseSeed[]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	for (const lease of leases) {
		sqlite
			.prepare(
				`INSERT INTO workstation_leases
				   (id, workstation_id, org_id, status, body_instance_id,
				    body_instance_name, body_instance_observed_at, created_at, updated_at)
				 VALUES (?, ?, 'org-1', ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
			)
			.run(
				lease.id,
				`ws-${lease.id}`,
				lease.status,
				lease.instanceId ?? null,
				lease.instanceName ?? null,
				lease.observedAt ?? null,
			);
	}
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const INSTANCE_ID =
	"0f5a3d5cb4f0b7a4c5e6d7f80192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4";

describe("recordWorkstationLeaseBodyInstance", () => {
	it("stamps the container identity onto the lease", async () => {
		const { db, sqlite } = seed([{ id: "lease-1", status: "active" }]);

		await recordWorkstationLeaseBodyInstance(db, {
			instanceId: INSTANCE_ID,
			instanceName: "ws_general_org_cto_-y4hb4n-we2",
			leaseId: "lease-1",
			observedAt: "2026-09-17T10:00:00.000Z",
		});

		const [row] = sqlite
			.prepare("SELECT * FROM workstation_leases WHERE id = 'lease-1'")
			.all() as Record<string, unknown>[];
		expect(row?.body_instance_id).toBe(INSTANCE_ID);
		expect(row?.body_instance_name).toBe("ws_general_org_cto_-y4hb4n-we2");
		expect(row?.body_instance_observed_at).toBe("2026-09-17T10:00:00.000Z");
	});
});

describe("listReapableWorkstationBodies", () => {
	it("returns a body whose every lease is terminal", async () => {
		const { db } = seed([
			{
				id: "lease-1",
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				observedAt: "2026-09-10T00:00:00.000Z",
				status: "released",
			},
			{
				id: "lease-2",
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				observedAt: "2026-09-12T00:00:00.000Z",
				status: "expired",
			},
		]);

		const reapable = await listReapableWorkstationBodies(db, { limit: 10 });

		expect(reapable).toEqual([
			{
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				lastObservedAt: "2026-09-12T00:00:00.000Z",
				leaseCount: 2,
				orgId: "org-1",
			},
		]);
	});

	it("never reaps a body one live lease still claims", async () => {
		// The failure the per-lease predicate would cause: one terminal lease on a
		// container another lease is still executing in.
		const { db } = seed([
			{
				id: "lease-1",
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				status: "expired",
			},
			{
				id: "lease-2",
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				status: "active",
			},
		]);

		expect(await listReapableWorkstationBodies(db, { limit: 10 })).toEqual([]);
	});

	it("treats a blocked lease as live, because it is not terminal", async () => {
		const { db } = seed([
			{
				id: "lease-1",
				instanceId: INSTANCE_ID,
				instanceName: "body-a",
				status: "blocked",
			},
		]);

		expect(await listReapableWorkstationBodies(db, { limit: 10 })).toEqual([]);
	});

	it("excludes a lease that never recorded a body rather than guessing one", async () => {
		// Every pre-existing production lease is this row. It cannot prove which
		// container it held, so it is not a reap candidate.
		const { db } = seed([{ id: "lease-1", status: "expired" }]);

		expect(await listReapableWorkstationBodies(db, { limit: 10 })).toEqual([]);
	});
});
