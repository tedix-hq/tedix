import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	cancelGraphProjectionMaintenance,
	commitGraphProjectionMaintenanceGdsSuccess,
	GraphProjectionMaintenanceIdempotencyError,
	getGraphProjectionMaintenanceRun,
	listStaleGraphProjectionMaintenanceRuns,
	markGraphProjectionMaintenanceRunning,
	requestGraphProjectionMaintenanceCancel,
	reserveGraphProjectionMaintenanceRun,
} from "./graph-projection-maintenance";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE graph_projection_maintenance_runs (
			id TEXT PRIMARY KEY,
			runtime_environment TEXT NOT NULL,
			organization_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL,
			workflow_id TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'queued',
			result TEXT,
			error TEXT,
			cancel_reason TEXT,
			cancel_requested_at TEXT,
			created_at TEXT NOT NULL,
			started_at TEXT,
			completed_at TEXT,
			updated_at TEXT NOT NULL,
			UNIQUE (runtime_environment, organization_id, idempotency_key)
		);
		CREATE INDEX idx_graph_projection_maintenance_status_updated
			ON graph_projection_maintenance_runs
			(runtime_environment, status, updated_at, id);
		CREATE TABLE graph_projection_consumers (
			organization_id TEXT PRIMARY KEY,
			last_projected_sequence INTEGER NOT NULL
		);
		CREATE TABLE graph_projection_outbox (
			sequence INTEGER PRIMARY KEY,
			organization_id TEXT NOT NULL
		);
		CREATE TABLE graph_projection_readiness (
			organization_id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			reason TEXT,
			projection_epoch TEXT,
			persisted_watermark INTEGER NOT NULL DEFAULT 0,
			gds_watermark INTEGER NOT NULL DEFAULT 0,
			gds_epoch TEXT,
			node_mismatch_count INTEGER,
			edge_mismatch_count INTEGER,
			lifecycle_mismatch_count INTEGER,
			repair_id TEXT,
			repair_phase TEXT,
			repair_cursor TEXT,
			repair_high_water INTEGER,
			repair_started_at TEXT,
			last_certified_at TEXT,
			updated_at TEXT NOT NULL
		);
		INSERT INTO graph_projection_consumers
			(organization_id, last_projected_sequence) VALUES ('org-1', 42);
		INSERT INTO graph_projection_readiness (
			organization_id, state, projection_epoch, persisted_watermark,
			gds_watermark, updated_at
		) VALUES ('org-1', 'ready', 'epoch-1', 42, 0, '2026-07-28T00:00:00.000Z');
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

const reservation = {
	id: "graph-gds-run-1",
	runtimeEnvironment: "production" as const,
	organizationId: "org-1",
	operation: "gds_refresh" as const,
	idempotencyKey: "stable-key-1",
	requestFingerprint: "gds_refresh:v1",
};

describe("graph projection maintenance lifecycle", () => {
	it("deduplicates within one environment and rejects fingerprint drift", async () => {
		const { db } = fixture();
		const first = await reserveGraphProjectionMaintenanceRun(db, reservation);
		const replay = await reserveGraphProjectionMaintenanceRun(db, reservation);

		expect(first.deduplicated).toBe(false);
		expect(replay.deduplicated).toBe(true);
		expect(replay.run.id).toBe(first.run.id);
		await expect(
			reserveGraphProjectionMaintenanceRun(db, {
				...reservation,
				id: "graph-gds-run-2",
				requestFingerprint: "gds_refresh:v2",
			}),
		).rejects.toBeInstanceOf(GraphProjectionMaintenanceIdempotencyError);
	});

	it("fences task lookup and idempotency by environment and organization", async () => {
		const { db } = fixture();
		await reserveGraphProjectionMaintenanceRun(db, reservation);

		await expect(
			getGraphProjectionMaintenanceRun(
				db,
				"production",
				"org-1",
				reservation.id,
			),
		).resolves.toMatchObject({ id: reservation.id });
		await expect(
			getGraphProjectionMaintenanceRun(db, "staging", "org-1", reservation.id),
		).resolves.toBeNull();
		await expect(
			getGraphProjectionMaintenanceRun(
				db,
				"production",
				"org-2",
				reservation.id,
			),
		).resolves.toBeNull();
	});

	it("discovers only bounded stale non-terminal rows in the same environment", async () => {
		const { db, sqlite } = fixture();
		await reserveGraphProjectionMaintenanceRun(db, reservation);
		await reserveGraphProjectionMaintenanceRun(db, {
			...reservation,
			id: "graph-gds-run-2",
			idempotencyKey: "stable-key-2",
		});
		sqlite
			.prepare(
				"UPDATE graph_projection_maintenance_runs SET updated_at = ? WHERE id = ?",
			)
			.run("2026-07-28T00:00:00.000Z", reservation.id);
		await markGraphProjectionMaintenanceRunning(
			db,
			"production",
			reservation.organizationId,
			"graph-gds-run-2",
		);

		await expect(
			listStaleGraphProjectionMaintenanceRuns(db, {
				runtimeEnvironment: "production",
				updatedBefore: "2026-07-28T00:00:30.000Z",
				limit: 10,
			}),
		).resolves.toEqual([
			expect.objectContaining({ id: reservation.id, status: "queued" }),
		]);
		await expect(
			listStaleGraphProjectionMaintenanceRuns(db, {
				runtimeEnvironment: "staging",
				updatedBefore: "2026-07-28T00:00:30.000Z",
				limit: 10,
			}),
		).resolves.toEqual([]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM graph_projection_maintenance_runs WHERE runtime_environment = 'production' AND status IN ('queued','running','cancel_requested') AND updated_at <= ? ORDER BY updated_at, id LIMIT 10",
			)
			.all("2026-07-28T00:00:30.000Z") as Array<{ detail: string }>;
		expect(plan.some((row) => row.detail.includes("status_updated"))).toBe(
			true,
		);
	});

	it("lets cancellation win before the terminal freshness transaction", async () => {
		const { db, sqlite } = fixture();
		await reserveGraphProjectionMaintenanceRun(db, reservation);
		await markGraphProjectionMaintenanceRunning(
			db,
			"production",
			reservation.organizationId,
			reservation.id,
		);
		await requestGraphProjectionMaintenanceCancel(
			db,
			"production",
			reservation.organizationId,
			reservation.id,
			"operator request",
		);

		await expect(
			commitGraphProjectionMaintenanceGdsSuccess(db, {
				runtimeEnvironment: "production",
				organizationId: reservation.organizationId,
				id: reservation.id,
				watermark: 42,
				epoch: "epoch-1",
				result: { operation: "gds_refresh", watermark: 42, epoch: "epoch-1" },
			}),
		).resolves.toBe(false);
		await cancelGraphProjectionMaintenance(
			db,
			"production",
			reservation.organizationId,
			reservation.id,
		);
		await expect(
			getGraphProjectionMaintenanceRun(
				db,
				"production",
				reservation.organizationId,
				reservation.id,
			),
		).resolves.toMatchObject({ status: "canceled" });
		expect(
			sqlite
				.prepare(
					"SELECT gds_watermark, gds_epoch FROM graph_projection_readiness WHERE organization_id = ?",
				)
				.get("org-1"),
		).toEqual({ gds_watermark: 0, gds_epoch: null });
	});

	it("rejects terminal success when a newer outbox event races verification", async () => {
		const { db, sqlite } = fixture();
		await reserveGraphProjectionMaintenanceRun(db, reservation);
		await markGraphProjectionMaintenanceRunning(
			db,
			"production",
			reservation.organizationId,
			reservation.id,
		);
		sqlite
			.prepare(
				"INSERT INTO graph_projection_outbox (sequence, organization_id) VALUES (?, ?)",
			)
			.run(43, "org-1");

		await expect(
			commitGraphProjectionMaintenanceGdsSuccess(db, {
				runtimeEnvironment: "production",
				organizationId: "org-1",
				id: reservation.id,
				watermark: 42,
				epoch: "epoch-1",
				result: { operation: "gds_refresh" },
			}),
		).resolves.toBe(false);
		expect(
			sqlite
				.prepare(
					"SELECT gds_watermark, gds_epoch FROM graph_projection_readiness WHERE organization_id = ?",
				)
				.get("org-1"),
		).toEqual({ gds_watermark: 0, gds_epoch: null });
		await expect(
			getGraphProjectionMaintenanceRun(
				db,
				"production",
				"org-1",
				reservation.id,
			),
		).resolves.toMatchObject({ status: "running" });
	});

	it("publishes the exact stable GDS stamp and completed receipt together", async () => {
		const { db, sqlite } = fixture();
		await reserveGraphProjectionMaintenanceRun(db, reservation);
		await markGraphProjectionMaintenanceRunning(
			db,
			"production",
			reservation.organizationId,
			reservation.id,
		);

		await expect(
			commitGraphProjectionMaintenanceGdsSuccess(db, {
				runtimeEnvironment: "production",
				organizationId: reservation.organizationId,
				id: reservation.id,
				watermark: 42,
				epoch: "epoch-1",
				result: {
					operation: "gds_refresh",
					organizationId: "org-1",
					watermark: 42,
					epoch: "epoch-1",
				},
			}),
		).resolves.toBe(true);
		await expect(
			getGraphProjectionMaintenanceRun(
				db,
				"production",
				reservation.organizationId,
				reservation.id,
			),
		).resolves.toMatchObject({
			status: "completed",
			result: {
				operation: "gds_refresh",
				watermark: 42,
				epoch: "epoch-1",
			},
		});
		expect(
			sqlite
				.prepare(
					"SELECT gds_watermark, gds_epoch FROM graph_projection_readiness WHERE organization_id = ?",
				)
				.get("org-1"),
		).toEqual({ gds_watermark: 42, gds_epoch: "epoch-1" });
	});
});
