import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../client";
import { createDbClient } from "../client";
import { coreTable } from "../core-store/client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getGraphProjectionCanonicalManagedCounts,
	getGraphProjectionCanonicalEdgeSample,
} from "./graph-projection-health";
import { organizations } from "../schema/organizations";
import {
	memoryDomains,
	memoryFacts,
	memoryEdges,
} from "../schema/memory-graph";
import { graphProjectionOutbox } from "../schema/graph-projection";
import {
	acquireGraphProjectionLease,
	advanceGraphProjectionCursor,
	readGraphProjectionBatch,
	listGraphProjectionOrganizations,
	measureGraphProjectionBacklog,
	recordGraphProjectionFailure,
	hydrateCanonicalGraphProjectionRows,
	setGraphProjectionReadiness,
	pruneAcknowledgedGraphProjectionEvents,
} from "./graph-projection";
import {
	getProjectionEdge,
	getProjectionFact,
	listProjectionEntities,
} from "./graph-projection-read-model";
import {
	reserveGraphProjectionMaintenanceRun,
	markGraphProjectionMaintenanceRunning,
	commitGraphProjectionMaintenanceGdsSuccess,
} from "./graph-projection-maintenance";

for (const store of ["d1", "postgres"] as const)
	describe(`projection core store ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const at = "2026-11-20T12:00:00.000Z";
		beforeAll(async () => {
			let installHooks = async () => {};
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
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
					for (const ddl of migration.sql) {
						if (
							ddl.includes(
								"CREATE FUNCTION emit_graph_projection_outbox_marks_unready()",
							)
						)
							installHooks = async () => {
								await fixture.engine.exec(ddl);
							};
						else await fixture.engine.exec(ddl);
					}
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db
				.insert(coreTable(db, memoryDomains))
				.values({ id: "domain", organizationId: "org", name: "Domain" });
			await db.insert(coreTable(db, memoryFacts)).values([
				{
					id: "fact",
					organizationId: "org",
					content: "Fact",
					factType: "technical",
					metadata: { nested: { value: true } },
					domainId: "domain",
				},
				{
					id: "target",
					organizationId: "org",
					content: "Target",
					factType: "technical",
				},
				{
					id: "foreign",
					organizationId: "other",
					content: "Other",
					factType: "technical",
				},
			]);
			await db.insert(coreTable(db, memoryEdges)).values({
				id: "edge",
				sourceFactId: "fact",
				targetFactId: "target",
				relationType: "related_to",
			});
			// Seed before the Postgres hooks to exercise their locked counter backfill.
			await installHooks();
			await db.delete(coreTable(db, graphProjectionOutbox));
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("hydrates a heterogeneous set in input order without crossing organizations or returning tombstones", async () => {
			const events = [
				["fact", "fact", "org", "upsert"],
				["edge", "edge", "org", "upsert"],
				["fact", "fact", "other", "upsert"],
				["fact", "foreign", "other", "delete"],
				["domain", "domain", "org", "upsert"],
				["fact", "fact", "org", "upsert"],
			].map(([entityKind, entityId, organizationId, operation], sequence) => ({
				sequence,
				eventId: String(sequence),
				entityKind,
				entityId,
				organizationId,
				operation,
				payload: null,
				schemaVersion: 1,
				attemptCount: 0,
				nextAttemptAt: null,
				lastError: null,
				poisonedAt: null,
				createdAt: at,
			})) as Parameters<typeof hydrateCanonicalGraphProjectionRows>[1];
			expect(
				await getGraphProjectionCanonicalManagedCounts(db, "org"),
			).toMatchObject({ facts: 2, edges: 1, domains: 1 });
			expect(
				(await getGraphProjectionCanonicalEdgeSample(db, "org")).map(
					(row) => row.id,
				),
			).toEqual(["edge"]);
			const rows = await hydrateCanonicalGraphProjectionRows(db, events);
			expect(rows.map((row) => row?.id ?? null)).toEqual([
				"fact",
				"edge",
				null,
				null,
				"domain",
				"fact",
			]);
			expect(rows[1]?.organization_id).toBe("org");
			expect(rows[0]).toEqual(rows[5]);
			expect(
				await getProjectionFact(db, {
					organizationId: "other",
					entityId: "fact",
				}),
			).toBeNull();
			expect(
				await getProjectionEdge(db, {
					organizationId: "org",
					entityId: "edge",
				}),
			).toMatchObject({ sourceFactId: "fact", targetFactId: "target" });
			expect(
				await listProjectionEntities(db, { organizationId: "org", limit: 5 }),
			).toEqual([]);
		});

		it("keeps poisoned heads discoverable and enforces lease and maintenance fences", async () => {
			const outbox = coreTable(db, graphProjectionOutbox);
			const [event] = await db
				.insert(outbox)
				.values({
					eventId: "pending",
					organizationId: "org",
					entityKind: "fact",
					entityId: "fact",
					operation: "upsert",
					createdAt: "2026-01-01 00:00:00",
				})
				.returning();
			expect(event).toBeDefined();
			expect(await listGraphProjectionOrganizations(db)).toEqual(["org"]);
			expect(await acquireGraphProjectionLease(db, "org", "owner")).toBe(true);
			expect(await acquireGraphProjectionLease(db, "org", "stale")).toBe(false);
			await recordGraphProjectionFailure(
				db,
				{ ...event!, attemptCount: 7 },
				"unavailable",
			);
			expect(
				(await readGraphProjectionBatch(db, "org", 0))[0]?.poisonedAt,
			).not.toBeNull();
			expect(await listGraphProjectionOrganizations(db)).toEqual(["org"]);
			expect(
				await measureGraphProjectionBacklog(
					db,
					[
						{ organizationId: "org", cursor: 0 },
						{ organizationId: "other", cursor: 0 },
					],
					1,
				),
			).toEqual({ organizations: 2, pending: 1, capped: 1 });
			expect(
				await advanceGraphProjectionCursor(db, "org", "stale", event!.sequence),
			).toBe(false);
			expect(
				await advanceGraphProjectionCursor(db, "org", "owner", event!.sequence),
			).toBe(true);
			const reservation = {
				id: "run",
				runtimeEnvironment: "production" as const,
				organizationId: "org",
				operation: "gds_refresh" as const,
				idempotencyKey: "key",
				requestFingerprint: "fingerprint",
			};
			expect(
				(await reserveGraphProjectionMaintenanceRun(db, reservation))
					.deduplicated,
			).toBe(false);
			expect(
				(
					await reserveGraphProjectionMaintenanceRun(db, {
						...reservation,
						id: "duplicate",
					})
				).deduplicated,
			).toBe(true);
			await markGraphProjectionMaintenanceRunning(
				db,
				"production",
				"org",
				"run",
			);
			await setGraphProjectionReadiness(db, {
				organizationId: "org",
				state: "ready",
				projectionEpoch: "epoch",
				persistedWatermark: event!.sequence,
			});
			const success = {
				runtimeEnvironment: "production" as const,
				organizationId: "org",
				id: "run",
				watermark: event!.sequence,
				epoch: "epoch",
				result: { nodes: 1 },
			};
			expect(
				await commitGraphProjectionMaintenanceGdsSuccess(db, {
					...success,
					epoch: "stale",
				}),
			).toBe(false);
			expect(
				await commitGraphProjectionMaintenanceGdsSuccess(db, success),
			).toBe(true);
			expect(
				await pruneAcknowledgedGraphProjectionEvents(db, { now: new Date(at) }),
			).toBe(1);
			expect(await listGraphProjectionOrganizations(db)).toEqual([]);
		});

		it("rolls back both failure writes when the consumer write is rejected", async () => {
			const outbox = coreTable(db, graphProjectionOutbox);
			const [event] = await db
				.insert(outbox)
				.values({
					eventId: "rollback",
					organizationId: "org",
					entityKind: "fact",
					entityId: "fact",
					operation: "upsert",
				})
				.returning();
			if (store === "postgres") {
				await db.run(
					sql`CREATE FUNCTION reject_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION 'rejected'; END; $function$`,
				);
				await db.run(
					sql`CREATE TRIGGER reject_projection_failure BEFORE UPDATE OF last_error ON graph_projection_consumers FOR EACH ROW WHEN (NEW.last_error = 'reject') EXECUTE FUNCTION reject_projection_failure()`,
				);
			} else {
				await db.run(
					sql`CREATE TRIGGER reject_projection_failure BEFORE UPDATE OF last_error ON graph_projection_consumers WHEN NEW.last_error = 'reject' BEGIN SELECT RAISE(ABORT, 'rejected'); END`,
				);
			}
			await expect(
				recordGraphProjectionFailure(db, event!, "reject"),
			).rejects.toThrow();
			expect(
				(await readGraphProjectionBatch(db, "org", event!.sequence - 1))[0]
					?.attemptCount,
			).toBe(0);
		});
		it("emits old relation tombstones, rejects tenant moves and rolls back canonical writes with their events", async () => {
			const facts = coreTable(db, memoryFacts);
			const edges = coreTable(db, memoryEdges);
			const outbox = coreTable(db, graphProjectionOutbox);
			await db.delete(outbox);
			await db
				.update(edges)
				.set({ relationType: "requires" })
				.where(eq(edges.id, "edge"));
			const changed = await readGraphProjectionBatch(db, "org", 0);
			expect(changed).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						entityKind: "edge",
						operation: "delete",
						payload: expect.objectContaining({ relationType: "related_to" }),
					}),
					expect.objectContaining({
						entityKind: "edge",
						entityId: "edge",
						operation: "upsert",
					}),
				]),
			);
			await expect(
				db
					.update(facts)
					.set({ organizationId: "other" })
					.where(eq(facts.id, "fact")),
			).rejects.toThrow();
			await expect(
				db
					.update(edges)
					.set({ targetFactId: "foreign" })
					.where(eq(edges.id, "edge")),
			).rejects.toThrow();
			const before = await readGraphProjectionBatch(db, "org", 0);
			await expect(
				db.batch([
					db
						.update(facts)
						.set({ content: "must roll back" })
						.where(eq(facts.id, "fact")),
					db
						.update(facts)
						.set({ content: sql`NULL` })
						.where(eq(facts.id, "target")),
				]),
			).rejects.toThrow();
			expect(
				(
					await getProjectionFact(db, {
						organizationId: "org",
						entityId: "fact",
					})
				)?.content,
			).toBe("Fact");
			expect(await readGraphProjectionBatch(db, "org", 0)).toEqual(before);
			await db.delete(facts).where(eq(facts.id, "target"));
			const deleted = await readGraphProjectionBatch(
				db,
				"org",
				before.at(-1)!.sequence,
			);
			expect(deleted).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						entityKind: "fact",
						entityId: "target",
						operation: "delete",
					}),
					expect.objectContaining({
						entityKind: "edge",
						operation: "delete",
						payload: expect.objectContaining({ targetFactId: "target" }),
					}),
				]),
			);
			expect(
				await getProjectionEdge(db, {
					organizationId: "org",
					entityId: "edge",
				}),
			).toBeNull();
		});
	});
