import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { workstationLeases, workstations } from "../schema/workstations";
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
describe.each(["d1", "postgres"] as const)("%s core store", (store) => {
	let db: DbQueryClient;
	let close: () => void | Promise<void>;
	let nextId = 0;
	beforeAll(async () => {
		if (store === "d1") {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(
				schemaDdl(organizations, tedis, workstations, workstationLeases),
			);
			db = createDbQueryClient(createD1Facade(sqlite));
			close = () => sqlite.close();
		} else {
			const fixture = await createPGliteFacade();
			db = fixture.db;
			close = fixture.close;
			for (const migration of readMigrationFiles({
				migrationsFolder: fileURLToPath(
					new URL("../../drizzle-pg", import.meta.url),
				),
			}))
				for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		}
		await db
			.insert(coreTable(db, organizations))
			.values({ id: "org-a", name: "Fixture", slug: "fixture" });
		await db.insert(coreTable(db, workstations)).values({
			id: "station-1",
			profileId: "general",
			status: "ready",
			createdAt: NOW,
			updatedAt: NOW,
		});
	}, 30_000);
	afterAll(async () => {
		await close?.();
	});
	async function fixture(kind: RuntimeBodyGenerationRecord["kind"]) {
		await db.delete(coreTable(db, workstationLeases));
		await db.delete(coreTable(db, tedis));
		const id = String(++nextId);
		await db.insert(coreTable(db, tedis)).values({
			id: `tedi-${id}`,
			organizationId: "org-a",
			name: "Fixture worker",
			slug: `fixture-${id}`,
		});
		await db.insert(coreTable(db, workstationLeases)).values({
			id: `lease-${id}`,
			workstationId: "station-1",
			profileId: "general",
			status: "active",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const record: RuntimeBodyGenerationRecord = {
			kind,
			id: `${kind === "tedi" ? "tedi" : "lease"}-${id}`,
			tediId: `tedi-${id}`,
		};
		const table = coreTable(db, kind === "tedi" ? tedis : workstationLeases);
		const readOwner = async () =>
			(await db.select().from(table).where(eq(table.id, record.id)))[0];
		return { db, record, readOwner };
	}

	describe.each(["tedi", "workstationLease"] as const)(
		"%s body generations",
		(kind) => {
			it("reads unarmed and missing records, and does not create a missing owner", async () => {
				const { db, record } = await fixture(kind);
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
				expect(
					await armRuntimeBodyGeneration(db, missing, generation, NOW),
				).toBe(false);
				expect(await readRuntimeBodyGeneration(db, missing)).toBeNull();
			});

			it("arms and replaces a generation, resetting its heartbeat and credentials", async () => {
				const { db, record } = await fixture(kind);
				expect(
					await armRuntimeBodyGeneration(db, record, generation, NOW),
				).toBe(true);
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
				const { db, record } = await fixture(kind);
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
				expect(
					await touchRuntimeBodyGenerationHeartbeat(db, record, stale),
				).toBe(false);
				await terminateRuntimeBodyGeneration(db, record, stale);
				expect(await readRuntimeBodyGeneration(db, record)).toEqual(before);
			});

			it("updates current status and heartbeat, recording last seen only for online status", async () => {
				const { db, record, readOwner } = await fixture(kind);
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
						((await readOwner()) as typeof tedis.$inferSelect).lastSeenAt,
					).toEqual(NOW);
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
						((await readOwner()) as typeof tedis.$inferSelect).lastSeenAt,
					).toEqual(LATER);
				else expect((await readOwner())?.updatedAt).toEqual(LATER);
			});

			it("terminates idempotently and clears the generation credential", async () => {
				const { db, record } = await fixture(kind);
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

			it.each(["armed", "starting", "ready"] as const)(
				"accepts heartbeat for a %s generation",
				async (status) => {
					const { db, record } = await fixture(kind);
					await armRuntimeBodyGeneration(
						db,
						record,
						{ ...generation, status },
						NOW,
					);
					expect(
						await touchRuntimeBodyGenerationHeartbeat(db, record, {
							generationId: generation.generationId,
							externalId: "active-body",
							at: LATER,
						}),
					).toBe(true);
					expect(await readRuntimeBodyGeneration(db, record)).toMatchObject({
						bodyGenerationStatus: status,
						bodyGenerationExternalId: "active-body",
						bodyGenerationHeartbeatAt: LATER,
					});
				},
			);

			it.each(["failed", "terminated", "expired"] as const)(
				"rejects heartbeat for a %s generation",
				async (status) => {
					const { db, record, readOwner } = await fixture(kind);
					await armRuntimeBodyGeneration(
						db,
						record,
						{ ...generation, status },
						NOW,
					);
					const before = await readOwner();
					expect(
						await touchRuntimeBodyGenerationHeartbeat(db, record, {
							generationId: generation.generationId,
							externalId: "late-body",
							at: LATER,
						}),
					).toBe(false);
					expect(await readOwner()).toEqual(before);
				},
			);
		},
	);
});
