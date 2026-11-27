import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import { tedis } from "../../schema/tedis";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import {
	notifyStoppedLanes,
	readLaneState,
	recordStaleLanes,
} from "./lane-lifecycle";

const start = "2026-10-17T12:00:00.000Z";
const stale = "2026-10-17T12:02:30.000Z";
const expiry = "2026-10-17T12:05:00.000Z";

// The lane sweep's JSON flags, midpoint math and JSON writes run on both stores.
for (const store of ["d1", "postgres"] as const)
	describe(`lane lifecycle ${store}`, () => {
		let db: DbQueryClient;
		let close: () => unknown;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec("PRAGMA foreign_keys=OFF");
				sqlite.exec(
					schemaDdl(
						workItems,
						workAttempts,
						workEvents,
						workInteractions,
						externalAgentPrincipals,
						agentSessionRequests,
						tedis,
						platformCronCheckpoints,
					),
				);
				db = createDbQueryClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				// Table shapes only, as on D1: no writer triggers or foreign keys.
				await fixture.engine.exec("SET session_replication_role = replica");
				db = fixture.db as unknown as DbQueryClient;
				close = fixture.close;
			}
			await db.insert(coreTable(db, workItems)).values({
				id: "item",
				orgId: "org-example",
				title: "Improve search",
				disposition: "accepted",
				projectId: "project",
				maxAttempts: 1,
				createdAt: start,
			});
			await db.insert(coreTable(db, externalAgentPrincipals)).values({
				id: "agent",
				organizationId: "org-example",
				key: "agent",
				displayName: "Worker",
				credentialBindingType: "owner_user",
				credentialBindingId: "user-example",
				createdByType: "user",
				createdById: "user-example",
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				orgId: "org-example",
				workItemId: "item",
				executorType: "external_agent",
				executorId: "agent",
				executorSessionId: "session",
				externalSessionKey: "codex:example",
				attemptNumber: 1,
				startedAt: start,
				heartbeatAt: start,
				expiresAt: expiry,
				metadata: { lane: true },
			});
		});
		afterAll(() => close());

		it("records a stale lane once and notifies its next mover", async () => {
			expect(await readLaneState(db, "org-example", "attempt", start)).toBe(
				"ready",
			);
			expect(await readLaneState(db, "org-example", "attempt", stale)).toBe(
				"stale",
			);
			expect(await recordStaleLanes(db, "2026-10-17T12:02:29.000Z")).toBe(0);
			expect(await recordStaleLanes(db, stale)).toBe(1);
			expect(await recordStaleLanes(db, stale)).toBe(0);
			const events = coreTable(db, workEvents);
			const [event] = await db
				.select({ payload: events.payload })
				.from(events)
				.where(eq(events.eventType, "lane.stale"));
			expect(event!.payload).toEqual({ heartbeatAt: start });

			expect(await notifyStoppedLanes(db, stale)).toBe(1);
			const interactions = coreTable(db, workInteractions);
			const [card] = await db
				.select({
					targetId: interactions.targetId,
					metadata: interactions.metadata,
				})
				.from(interactions);
			expect(card).toMatchObject({
				targetId: "agent",
				metadata: { laneLifecycle: { state: "blocked" } },
			});
			const items = coreTable(db, workItems);
			const [item] = await db
				.select({
					dispatchState: items.dispatchState,
					metadata: items.metadata,
				})
				.from(items);
			expect(item).toMatchObject({
				dispatchState: "held",
				metadata: {
					laneDispatch: { reason: expect.any(String) },
					laneLifecycle: { state: "blocked" },
				},
			});
		});
	});
