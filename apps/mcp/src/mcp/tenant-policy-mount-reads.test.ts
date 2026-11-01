/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import {
	getAppByIdWithToolsForOrganization,
	getAppPolicyMountMetadataForOrganization,
} from "@tedix/db/queries/app-records";
import {
	apps,
	appTools,
	appToolCspDomains,
	organizations,
	connectionInstances,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { prepareTenantNativePolicyMount } from "./tenant-policy-mount";

const mocks = vi.hoisted(() => ({
	client: {} as Record<string, unknown>,
	aggregate: vi.fn(),
}));
vi.mock("../lib/api-client", () => ({ getApiClient: () => mocks.client }));
vi.mock("../aggregate-surface", () => ({
	aggregateAndPrefixTools: mocks.aggregate,
}));

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	// This read fixture contains only the app/tool tables, without catalog/type parents.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(apps, appTools, appToolCspDomains));
	const insertApp = sqlite.prepare(
		"INSERT INTO apps (id, organization_id, slug, name, created_at, updated_at) VALUES (?, 'org-fictional', ?, ?, '2026-11-01', '2026-11-01')",
	);
	const insertTool = sqlite.prepare(
		"INSERT INTO app_tools (id, app_id, tool_type_id, tool_id, title, input_schema, output_schema, enabled, config, created_at) VALUES (?, ?, 'rpc', ?, ?, ?, ?, 1, ?, '2026-11-01')",
	);
	const schema = JSON.stringify({
		type: "object",
		properties: { payload: { type: "string", description: "x".repeat(4096) } },
	});
	for (const appId of ["root", "source"]) {
		insertApp.run(appId, appId, appId);
		for (let i = 0; i < 200; i++) {
			const toolId = `call_${i}`;
			insertTool.run(
				`${appId}-${i}`,
				appId,
				toolId,
				toolId,
				schema,
				schema,
				JSON.stringify({ transport: "rpc", endpoint: "work/get" }),
			);
		}
	}
	const reads: string[] = [];
	let schemaBytes = 0;
	const facade = createD1Facade(
		{
			exec: (sql) => sqlite.exec(sql),
			prepare(query) {
				const statement = sqlite.prepare(query);
				return {
					all(...params: unknown[]) {
						const rows = statement.all(...(params as SQLInputValue[]));
						reads.push(query);
						// Count schema bytes returned by SQLite, before Drizzle decodes JSON.
						for (const row of rows) {
							for (const key of ["input_schema", "output_schema"]) {
								const value = row[key];
								if (typeof value === "string")
									schemaBytes += new TextEncoder().encode(value).length;
							}
						}
						return rows;
					},
					get: (...params: unknown[]) =>
						statement.get(...(params as SQLInputValue[])),
					run: (...params: unknown[]) =>
						statement.run(...(params as SQLInputValue[])),
				};
			},
		},
		{ maxBoundParams: 100 },
	);
	const db = createDbClient(facade);

	const full = async ({
		appId,
		toolIds,
	}: {
		appId: string;
		toolIds?: string[];
	}) =>
		(await getAppByIdWithToolsForOrganization(db, appId, "org-fictional", {
			toolIds,
		})) ?? { app: null, tools: [] };
	const metadata = async ({ appId }: { appId: string }) =>
		(await getAppPolicyMountMetadataForOrganization(
			db,
			appId,
			"org-fictional",
		)) ?? { app: null, tools: [] };
	mocks.client = {
		apps: { getByIdWithTools: full, getPolicyMountMetadata: metadata },
	};
	// Bound the aggregate to one root and one source; its real schema reads remain in the measurement.
	mocks.aggregate.mockImplementation(async () => {
		await full({ appId: "root" });
		const surface = await full({ appId: "source" });
		return {
			tools: surface.tools
				.filter((row) => row.toolId === "call_0")
				.map((row) => ({
					...row,
					toolId: "source__call_0",
					config: { ...row.config, _sourceAppId: "source" },
					policyMountAppIds: ["root", "source"],
				})),
			degraded: false,
		};
	});
	return { sqlite, db, metadata, full, reads, bytes: () => schemaBytes };
}

const request = {
	organizationId: "org-fictional",
	rootAppId: "root",
	mountedToolId: "source__call_0",
	env: {} as CloudflareEnv,
};

describe("bounded native mount DB reads", () => {
	it("reads schemas only for aggregate hydration, not ownership or row identity", async () => {
		const f = fixture();
		const mount = await prepareTenantNativePolicyMount(request);
		expect(mount?.descriptor).toMatchObject({
			sourceAppId: "source",
			sourceToolRowId: "source-0",
			sourceToolId: "call_0",
		});
		// Same fixture on the previous resolver: 18 reads and 10,015,200 schema bytes.
		expect(f.reads).toHaveLength(12);
		expect(
			f.reads.filter((sql) => sql.includes('"input_schema"')),
		).toHaveLength(2);
		expect(f.bytes()).toBe(3338400);
	});

	it("keeps metadata fresh, tenant scoped and enabled-row scoped", async () => {
		const f = fixture();
		expect(
			await getAppPolicyMountMetadataForOrganization(
				f.db,
				"source",
				"other-org",
			),
		).toBeNull();
		expect(f.reads).toHaveLength(1);
		const first = await f.metadata({ appId: "source" });
		expect(first.tools).toHaveLength(200);
		expect(Object.keys(first.tools[0]!).sort()).toEqual(["id", "toolId"]);
		f.sqlite.exec("UPDATE app_tools SET enabled = 0 WHERE id = 'source-0'");
		expect((await f.metadata({ appId: "source" })).tools).toHaveLength(199);
		f.sqlite.exec(
			"UPDATE apps SET organization_id = 'other-org' WHERE id = 'source'",
		);
		expect((await f.metadata({ appId: "source" })).app).toBeNull();
		expect(f.bytes()).toBe(0);
	});

	it("retains connection ownership, resource restrictions and fresh revocation without schemas", async () => {
		const f = fixture();
		f.sqlite.exec(schemaDdl(organizations, connectionInstances));
		f.sqlite.exec(
			"INSERT INTO organizations (id, name, slug) VALUES ('org-fictional', 'Fictional', 'fictional')",
		);
		f.sqlite.exec(
			"INSERT INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, token_ids, created_at, updated_at) VALUES ('account', 'owner', 'org-fictional', 'provider', 'Account', '[]', '2026-11-01', '2026-11-01')",
		);
		f.sqlite
			.prepare("UPDATE app_tools SET config = ? WHERE id = 'source-0'")
			.run(
				JSON.stringify({
					transport: "rpc",
					endpoint: "work/get",
					auth: {
						type: "connection",
						connectionId: "provider",
						connectionInstanceId: "account",
					},
				}),
			);
		const visible = async () =>
			(await f.metadata({ appId: "source" })).tools.some(
				(row) => row.id === "source-0",
			);
		expect(await visible()).toBe(true);
		f.sqlite.exec(
			"UPDATE connection_instances SET organization_id = 'other-org' WHERE id = 'account'",
		);
		expect(await visible()).toBe(false);
		f.sqlite.exec(
			"UPDATE connection_instances SET organization_id = 'org-fictional' WHERE id = 'account'",
		);
		expect(await visible()).toBe(true);
		f.sqlite
			.prepare(
				"UPDATE organizations SET metadata = ? WHERE id = 'org-fictional'",
			)
			.run(JSON.stringify({ connectionResourceLimits: { provider: [] } }));
		expect(await visible()).toBe(false);
		f.sqlite.exec(
			"UPDATE organizations SET metadata = NULL WHERE id = 'org-fictional'",
		);
		f.sqlite.exec("DELETE FROM connection_instances WHERE id = 'account'");
		expect(await visible()).toBe(false);
		expect(f.bytes()).toBe(0);
	});

	it("loads only the requested direct tool schema and still filters disabled rows", async () => {
		const f = fixture();
		const selected = await f.full({ appId: "source", toolIds: ["call_0"] });
		expect(selected.tools.map((tool) => tool.id)).toEqual(["source-0"]);
		f.sqlite.exec("UPDATE app_tools SET enabled = 0 WHERE id = 'source-0'");
		expect(
			(await f.full({ appId: "source", toolIds: ["call_0"] })).tools,
		).toEqual([]);
	});
});
