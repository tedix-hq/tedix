import { createRouterClient } from "@orpc/server";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDbClient } from "@tedix/db/client";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORG = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const OTHER_ORG = "7c1d5f30-2b44-4e51-9a12-8d3f6b7c9e01";
const TEDI = "3d1a6a2e-8a4f-4b6e-9c1d-0f2e3a4b5c6d";
const mocks = vi.hoisted(() => ({
	getTediById: vi.fn(),
	auditMemoryGraph: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTediById,
}));
vi.mock("@tedix/db/queries/memory-audit", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/memory-audit")>()),
	auditMemoryGraph: mocks.auditMemoryGraph,
}));

async function audit(
	scope: "self" | "all",
	inherited = false,
	overrides: Partial<BaseContext> = {},
) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	const context = {
		authType: "user",
		db: {},
		env: { ENVIRONMENT: "test", DB: {} },
		headers: new Headers(),
		organizationId: ORG,
		...(inherited ? { tediId: TEDI } : {}),
		url: new URL("https://api.tedix.test/rpc/memoryGraph"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["tedis:read"],
			roles: [],
			sub: "user-1",
		},
		...overrides,
	} as unknown as BaseContext;
	return createRouterClient(memoryGraphContractRouter, { context }).audit({
		...(inherited ? {} : { tediId: TEDI }),
		scope,
		sourceSessionId: "exact-chat-run",
		limit: 6,
	});
}

describe("memory audit target ownership", () => {
	beforeAll(async () => {
		await import("./memory-graph");
	}, 120_000);
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it.each(["self", "all"] as const)(
		"rejects a foreign target before a misleading empty %s audit",
		async (scope) => {
			mocks.getTediById.mockResolvedValue({
				id: TEDI,
				organizationId: OTHER_ORG,
			});
			await expect(audit(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
		},
	);
	it("rejects an unknown target", async () => {
		mocks.getTediById.mockResolvedValue(null);
		await expect(audit("self")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
	});
	it("validates an inherited target too", async () => {
		mocks.getTediById.mockResolvedValue({
			id: TEDI,
			organizationId: OTHER_ORG,
		});
		await expect(audit("self", true)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"preserves same-organization audit filters (inherited=%s)",
		async (inherited) => {
			mocks.getTediById.mockResolvedValue({ id: TEDI, organizationId: ORG });
			const result = { facts: [{ id: "saved-fact" }], counts: { total: 1 } };
			mocks.auditMemoryGraph.mockResolvedValue(result);
			await expect(audit("self", inherited)).resolves.toEqual(result);
			expect(mocks.auditMemoryGraph).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: ORG, tediId: TEDI }),
				expect.objectContaining({
					scope: "self",
					source_session_id: "exact-chat-run",
					limit: 6,
				}),
			);
		},
	);
	it.each(["d1", "postgres"] as const)(
		"audits the selected %s store without reading the legacy D1 binding",
		async (dialect) => {
			const sqlite =
				dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
			const pg =
				dialect === "postgres" ? await createPGliteFacade() : undefined;
			try {
				if (sqlite) {
					sqlite.exec("PRAGMA foreign_keys = OFF");
					sqlite.exec(schemaDdl(memoryFacts));
				}
				if (pg) {
					for (const migration of readMigrationFiles({
						migrationsFolder: fileURLToPath(
							new URL("../../../../../packages/db/drizzle-pg", import.meta.url),
						),
					}))
						for (const ddl of migration.sql) await pg.engine.exec(ddl);
					await pg.engine.exec(`
						INSERT INTO organizations (id, name, slug) VALUES
						('${ORG}', 'Fictional', 'fictional'),
						('${OTHER_ORG}', 'Other', 'other');
					`);
				}
				const db = pg?.db ?? createDbClient(createD1Facade(sqlite!));
				await db.insert(memoryFacts).values(
					[ORG, OTHER_ORG].map((organizationId) => ({
						id: `fact-${organizationId}`,
						organizationId,
						content: "Saved audit evidence",
						factType: "knowledge" as const,
						sourceSessionId: "exact-chat-run",
						metadata: { producer: "audit-regression" },
					})),
				);
				const real = await vi.importActual<
					typeof import("@tedix/db/queries/memory-audit")
				>("@tedix/db/queries/memory-audit");
				mocks.auditMemoryGraph.mockImplementation(real.auditMemoryGraph);
				mocks.getTediById.mockResolvedValue({ id: TEDI, organizationId: ORG });
				const legacyRead = vi.fn(() => {
					throw new Error("Unexpected legacy D1 audit read");
				});
				await expect(
					audit("all", false, {
						db,
						env: {
							CORE_STORE: dialect,
							DB: { prepare: legacyRead },
						} as unknown as CloudflareEnv,
					}),
				).resolves.toMatchObject({
					ok: true,
					counts: { total: 1, byProducer: { "audit-regression": 1 } },
					facts: [{ id: `fact-${ORG}`, producer: "audit-regression" }],
				});
				expect(legacyRead).not.toHaveBeenCalled();
			} finally {
				sqlite?.close();
				await pg?.close();
				mocks.auditMemoryGraph.mockReset();
			}
		},
	);
});
