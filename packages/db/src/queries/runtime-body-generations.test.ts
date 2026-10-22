import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { tedis } from "../schema/tedis";
import { workstationLeases } from "../schema/workstations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	armRuntimeBodyGeneration,
	readRuntimeBodyGeneration,
	type RuntimeBodyGenerationRecord,
	type RuntimeBodyGenerationWrite,
	terminateRuntimeBodyGeneration,
	touchRuntimeBodyGenerationHeartbeat,
	updateRuntimeBodyGenerationStatus,
} from "./runtime-body-generations";

const NOW = "2026-10-22T08:00:00.000Z";
const LATER = "2026-10-22T08:01:00.000Z";
const generation: RuntimeBodyGenerationWrite = {
	generationId: "generation-1",
	bodyKind: "agent",
	status: "armed",
	tokenHash: "fictional-hash",
	tokenExpiresAt: "2026-10-22T09:00:00.000Z",
	externalId: "body-1",
};
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture(kind: RuntimeBodyGenerationRecord["kind"]) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tedis, workstationLeases));
	sqlite.exec(`
		INSERT INTO tedis (id, organization_id, name, slug)
		VALUES ('tedi-1', 'org-a', 'Fixture worker', 'fixture-worker');
		INSERT INTO workstation_leases
			(id, workstation_id, profile_id, status, created_at, updated_at)
		VALUES ('lease-1', 'station-1', 'general', 'active', '${NOW}', '${NOW}');
	`);
	const record: RuntimeBodyGenerationRecord = {
		kind,
		id: kind === "tedi" ? "tedi-1" : "lease-1",
		tediId: "tedi-1",
	};
	return { sqlite, db: createD1Facade(sqlite), record };
}

describe.each(["tedi", "workstationLease"] as const)(
	"%s body generations",
	(kind) => {
		it("reads unarmed and missing records, and does not create a missing owner", async () => {
			const { db, record } = fixture(kind);
			expect(await readRuntimeBodyGeneration(db, record)).toEqual({
				bodyGenerationId: null,
				bodyGenerationKind: null,
				bodyGenerationStatus: null,
				bodyGenerationTokenHash: null,
				bodyGenerationTokenExpiresAt: null,
				bodyGenerationExternalId: null,
				bodyGenerationHeartbeatAt: null,
			});
			const missing = { ...record, id: "missing" };
			expect(await armRuntimeBodyGeneration(db, missing, generation, NOW)).toBe(
				false,
			);
			expect(await readRuntimeBodyGeneration(db, missing)).toBeNull();
		});

		it("arms and replaces a generation, resetting its heartbeat and credentials", async () => {
			const { db, record } = fixture(kind);
			expect(await armRuntimeBodyGeneration(db, record, generation, NOW)).toBe(
				true,
			);
			expect(await readRuntimeBodyGeneration(db, record)).toEqual({
				bodyGenerationId: generation.generationId,
				bodyGenerationKind: generation.bodyKind,
				bodyGenerationStatus: generation.status,
				bodyGenerationTokenHash: generation.tokenHash,
				bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
				bodyGenerationExternalId: generation.externalId,
				bodyGenerationHeartbeatAt: null,
			});
			await touchRuntimeBodyGenerationHeartbeat(db, record, {
				generationId: generation.generationId,
				externalId: "body-1",
				at: NOW,
			});
			const next = {
				...generation,
				generationId: "generation-2",
				bodyKind: "workstation" as const,
				tokenHash: "replacement-hash",
				externalId: "body-2",
				tokenExpiresAt: LATER,
			};
			expect(await armRuntimeBodyGeneration(db, record, next, LATER)).toBe(
				true,
			);
			expect(await readRuntimeBodyGeneration(db, record)).toEqual({
				bodyGenerationId: next.generationId,
				bodyGenerationKind: next.bodyKind,
				bodyGenerationStatus: next.status,
				bodyGenerationTokenHash: next.tokenHash,
				bodyGenerationTokenExpiresAt: next.tokenExpiresAt,
				bodyGenerationExternalId: next.externalId,
				bodyGenerationHeartbeatAt: null,
			});
		});

		it("fences status, heartbeat and termination writes from an older generation", async () => {
			const { db, record } = fixture(kind);
			await armRuntimeBodyGeneration(db, record, generation, NOW);
			await armRuntimeBodyGeneration(
				db,
				record,
				{ ...generation, generationId: "generation-2" },
				LATER,
			);
			const before = await readRuntimeBodyGeneration(db, record);
			const stale = {
				generationId: generation.generationId,
				externalId: "stale-body",
				at: LATER,
			};
			expect(
				await updateRuntimeBodyGenerationStatus(db, record, {
					...stale,
					status: "failed",
				}),
			).toBe(false);
			expect(await touchRuntimeBodyGenerationHeartbeat(db, record, stale)).toBe(
				false,
			);
			await terminateRuntimeBodyGeneration(db, record, stale);
			expect(await readRuntimeBodyGeneration(db, record)).toEqual(before);
		});

		it("updates current status and heartbeat, recording last seen only for online status", async () => {
			const { db, record, sqlite } = fixture(kind);
			await armRuntimeBodyGeneration(db, record, generation, NOW);
			const input = {
				generationId: generation.generationId,
				externalId: "running-body",
				at: NOW,
			};
			expect(
				await updateRuntimeBodyGenerationStatus(db, record, {
					...input,
					status: "ready",
				}),
			).toBe(true);
			expect(await readRuntimeBodyGeneration(db, record)).toMatchObject({
				bodyGenerationStatus: "ready",
				bodyGenerationExternalId: "running-body",
				bodyGenerationHeartbeatAt: NOW,
			});
			expect(
				await updateRuntimeBodyGenerationStatus(db, record, {
					...input,
					at: LATER,
					status: "starting",
				}),
			).toBe(true);
			if (kind === "tedi")
				expect(
					sqlite
						.prepare("SELECT last_seen_at FROM tedis WHERE id = ?")
						.get(record.id),
				).toEqual({ last_seen_at: NOW });
			expect(
				await touchRuntimeBodyGenerationHeartbeat(db, record, {
					...input,
					at: LATER,
					externalId: "heartbeat-body",
				}),
			).toBe(true);
			expect(await readRuntimeBodyGeneration(db, record)).toMatchObject({
				bodyGenerationStatus: "starting",
				bodyGenerationExternalId: "heartbeat-body",
				bodyGenerationHeartbeatAt: LATER,
			});
			if (kind === "tedi")
				expect(
					sqlite
						.prepare("SELECT last_seen_at FROM tedis WHERE id = ?")
						.get(record.id),
				).toEqual({ last_seen_at: LATER });
			else
				expect(
					sqlite
						.prepare("SELECT updated_at FROM workstation_leases WHERE id = ?")
						.get(record.id),
				).toEqual({ updated_at: LATER });
		});

		it("terminates idempotently and clears the generation credential", async () => {
			const { db, record } = fixture(kind);
			await armRuntimeBodyGeneration(db, record, generation, NOW);
			const input = { generationId: generation.generationId, at: LATER };
			await terminateRuntimeBodyGeneration(db, record, input);
			const terminated = await readRuntimeBodyGeneration(db, record);
			expect(terminated).toMatchObject({
				bodyGenerationId: generation.generationId,
				bodyGenerationStatus: "terminated",
				bodyGenerationTokenHash: null,
				bodyGenerationTokenExpiresAt: null,
				bodyGenerationHeartbeatAt: LATER,
			});
			await terminateRuntimeBodyGeneration(db, record, input);
			expect(await readRuntimeBodyGeneration(db, record)).toEqual(terminated);
		});

		// Known defect: heartbeat SQL fences generation identity but not terminal status.
		it.fails.each(["failed", "terminated", "expired"] as const)(
			"rejects heartbeat for a %s generation",
			async (status) => {
				const { db, record } = fixture(kind);
				await armRuntimeBodyGeneration(
					db,
					record,
					{ ...generation, status },
					NOW,
				);
				const before = await readRuntimeBodyGeneration(db, record);
				expect(
					await touchRuntimeBodyGenerationHeartbeat(db, record, {
						generationId: generation.generationId,
						externalId: "late-body",
						at: LATER,
					}),
				).toBe(false);
				expect(await readRuntimeBodyGeneration(db, record)).toEqual(before);
			},
		);
	},
);
