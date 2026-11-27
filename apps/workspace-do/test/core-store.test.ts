import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { createDbClient } from "@tedix/db/client";
import { coreTable } from "@tedix/db/core-store/client";
import { coreQueryDb, withCoreStore } from "@tedix/db/core-store/scope";
import { providerModelRateVersions } from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osWorkspaceSummaries,
} from "@tedix/db/schema/os-workspaces";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
	workspaceOutputIndex,
} from "@tedix/db/schema/workspace-feed";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { WorkspaceDO } from "../src/do";
import { turnPricingIdentity } from "../src/model";
import { priceTurn } from "../src/pricing";
import { workspaceSessionAccess } from "../src/session-access";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
}));

// Replace only the network connection; exercise the real scope and query code.
const connection = vi.hoisted(() => ({
	db: undefined as DbClient | undefined,
	closed: 0,
}));
vi.mock("@tedix/db/core-store/client", async (original) => {
	const actual = await original<typeof import("@tedix/db/core-store/client")>();
	return {
		...actual,
		createCoreStore: (env: CoreStoreEnv) => {
			if (env.CORE_STORE !== "postgres") return actual.createCoreStore(env);
			if (!connection.db) throw new Error("Core connection unavailable");
			return {
				db: connection.db,
				close: async () => {
					connection.closed++;
				},
			};
		},
	};
});

const scope = {
	organizationId: "fixture-org",
	workspaceId: "fixture-workspace",
};
const at = "2026-11-20T10:00:00.000Z";

for (const dialect of ["d1", "postgres"] as const) {
	describe(dialect, () => {
		it("publishes activity, usage and prices through the selected core and closes each scope", async () => {
			const sqlite =
				dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
			const pg =
				dialect === "postgres" ? await createPGliteFacade() : undefined;
			try {
				if (sqlite) {
					sqlite.exec(
						"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('fixture-org');",
					);
					sqlite.exec(
						schemaDdl(
							osWorkspaces,
							osWorkspaceSummaries,
							workspaceActivity,
							workspaceFeedCursors,
							workspaceFeedLedger,
							workspaceOutputIndex,
							providerModelRateVersions,
						),
					);
				}
				if (pg) {
					for (const migration of readMigrationFiles({
						migrationsFolder: fileURLToPath(
							new URL("../../../packages/db/drizzle-pg", import.meta.url),
						),
					}))
						for (const ddl of migration.sql) await pg.engine.exec(ddl);
					await pg.engine.exec(
						"INSERT INTO organizations(id,name,slug) VALUES ('fixture-org','Fixture','fixture')",
					);
				}
				const d1 = sqlite
					? createD1Facade(sqlite)
					: {
							prepare() {
								throw new Error("Postgres must not touch D1");
							},
						};
				const db = pg?.db ?? createDbClient(d1 as D1Database);
				connection.db = db;
				connection.closed = 0;
				await db.insert(coreTable(db, osWorkspaces)).values({
					id: scope.workspaceId,
					organizationId: scope.organizationId,
					name: "Fixture",
					status: "active",
					createdByKind: "user",
					createdById: "fixture-user",
				});
				await db.insert(coreTable(db, osWorkspaceSummaries)).values({
					workspaceId: scope.workspaceId,
					organizationId: scope.organizationId,
					revision: 1,
					workLinks: "[]",
					usage: "{}",
					runStatus: "{}",
					publishedAt: at,
					appliedAt: at,
					createdAt: at,
					updatedAt: at,
				});
				const receiver = {
					env: { DB: d1, CORE_STORE: dialect },
				} as unknown as WorkspaceDO;
				const methods = WorkspaceDO.prototype as unknown as {
					projectEvent(event: unknown): Promise<void>;
					projectUsage(scope: unknown, counts: unknown): Promise<void>;
				};
				const event = {
					...scope,
					kind: "run",
					id: "turn-1",
					revision: 1,
					actor: { kind: "user", id: "fixture-user" },
					changeRecordId: "action-1",
					at,
					summary: {
						action: {
							resource: "output",
							operation: "revise",
							outcome: "applied",
							surface: "workspace_object",
							traceId: "turn-1",
						},
					},
				};
				await methods.projectEvent.call(receiver, event);
				await methods.projectEvent.call(receiver, event);
				await methods.projectUsage.call(receiver, scope, {
					usage: { conversationCount: 1, messageCount: 2, runCount: 1 },
					runStatus: {
						total: 1,
						active: 0,
						latestStatus: "completed",
						latestRunId: "turn-1",
						updatedAt: at,
					},
				});
				expect(
					await db.select().from(coreTable(db, workspaceActivity)),
				).toHaveLength(1);
				const [summary] = await db
					.select()
					.from(coreTable(db, osWorkspaceSummaries));
				expect(JSON.parse(summary!.usage!)).toMatchObject({
					conversationCount: 1,
					messageCount: 2,
					runCount: 1,
				});
				if (pg) expect(connection.closed).toBe(3);
				const env = {
					DB: d1 as D1Database,
					CORE_STORE: dialect,
					AI_GATEWAY_ACCOUNT_ID: "fixture-account",
				};
				const modelId = "@cf/example/model";
				await db.insert(coreTable(db, providerModelRateVersions)).values({
					id: "fixture-rate",
					...turnPricingIdentity(env, modelId)!,
					effectiveFrom: at,
					inputMicrousdPerMillion: 1_000_000,
					outputMicrousdPerMillion: 2_000_000,
					cacheReadMicrousdPerMillion: 500_000,
					cacheWriteMicrousdPerMillion: 3_000_000,
					currency: "USD",
					evidenceUri: "https://example.com/rates",
					evidenceDigest: "fixture-digest",
					verifiedAt: at,
					publishedAt: at,
					publishedBy: "fixture-user",
					changeReason: "fixture",
				});
				await withCoreStore(env, async () => {
					const query = coreQueryDb(env);
					const usage = {
						input: 10,
						output: 5,
						cacheRead: 4,
						cacheWrite: 2,
						partial: false,
					};
					const failedRead = vi
						.spyOn(query, "select")
						.mockImplementation(() => {
							throw new Error("Rate store unavailable");
						});
					try {
						expect(
							await priceTurn(
								query,
								env,
								modelId,
								{ ...usage, partial: true },
								at,
							),
						).toEqual({ costUnavailable: "usage incomplete" });
						expect(failedRead).not.toHaveBeenCalled();
						expect(await priceTurn(query, env, modelId, usage, at)).toEqual({
							costUnavailable: "price lookup failed",
						});
					} finally {
						failedRead.mockRestore();
					}
					expect(await priceTurn(query, env, modelId, usage, at)).toEqual({
						costUsd: 0.000028,
					});
					expect(
						await priceTurn(query, env, "@cf/example/missing", usage, at),
					).toEqual({ costUnavailable: "no price for this model" });
				});
				if (pg) expect(connection.closed).toBe(4);
			} finally {
				connection.db = undefined;
				sqlite?.close();
				await pg?.close();
			}
		});
	});
}

it("keeps an unavailable core access check distinct from revoked access", async () => {
	await expect(
		workspaceSessionAccess(
			{ CORE_STORE: "postgres" },
			{ scope, actorKind: "user", actorId: "fixture-user", scopes: null },
		),
	).resolves.toBe("unknown");
});
