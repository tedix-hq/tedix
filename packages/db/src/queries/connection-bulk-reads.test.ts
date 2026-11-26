import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { createCoreStore } from "../core-store/client";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { listOrganizationConnectionAllowedResources } from "./connection-providers";
import { listOrganizationConnectionInstances } from "./connection-instances";

const nativeUrl = process.env.TEST_POSTGRES_URL;
for (const store of ["d1", "pglite", "postgres"] as const) {
	describe.skipIf(store === "postgres" && !nativeUrl)(store, () => {
		it("reads each large set once and excludes foreign, personal, missing and mismatched pairs", async () => {
			let db: DbQueryClient;
			let close: () => void | Promise<void>;
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			} else if (store === "pglite") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
			} else {
				const url = new URL(nativeUrl!);
				if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
					throw new Error("Local PostgreSQL required");
				const admin = postgres(url.href, { max: 1 });
				const schema = `connections_${randomUUID().replaceAll("-", "")}`;
				await admin.unsafe(`CREATE SCHEMA "${schema}"`);
				url.searchParams.set("options", `-c search_path=${schema}`);
				const core = createCoreStore({
					CORE_STORE: "postgres",
					CORE_HYPERDRIVE: { connectionString: url.href },
				});
				db = core.db;
				close = async () => {
					await core.close();
					await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
					await admin.end();
				};
			}
			try {
				// Only the columns read by these projections; native JSON decoding still runs.
				const jsonType = store === "d1" ? "TEXT" : "JSONB";
				// Bind text before casting so postgres.js does not JSON-encode it twice.
				const json = (value: unknown) =>
					store === "d1"
						? sql`${JSON.stringify(value)}`
						: sql`${JSON.stringify(value)}::text::jsonb`;
				await db.run(
					sql.raw(
						`CREATE TABLE organizations (id TEXT PRIMARY KEY, metadata ${jsonType})`,
					),
				);
				await db.run(
					sql.raw(
						`CREATE TABLE connection_instances (id TEXT PRIMARY KEY, provider_id TEXT, organization_id TEXT, allowed_resources ${jsonType})`,
					),
				);
				const policy = [
					{
						resourceType: "github_repository" as const,
						resourceId: "example/repo",
					},
				];
				await db.run(
					sql`INSERT INTO organizations (id, metadata) VALUES (${"org"}, ${json({ connectionResourceLimits: { [encodeURIComponent("git/hub")]: policy, denied: [] } })}), (${"other"}, ${json({ connectionResourceLimits: { denied: policy } })})`,
				);
				for (const [id, providerId, organizationId, allowedResources] of [
					["slot", "git/hub", "org", policy],
					["unrestricted", "git/hub", "org", null],
					["foreign", "git/hub", "other", policy],
					["personal", "git/hub", null, policy],
				] as const)
					await db.run(
						sql`INSERT INTO connection_instances (id, provider_id, organization_id, allowed_resources) VALUES (${id}, ${providerId}, ${organizationId}, ${allowedResources === null ? sql`NULL` : json(allowedResources)})`,
					);
				const reads = vi.spyOn(db, "select");
				const ids = [
					"git/hub",
					"denied",
					...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
					"git/hub",
				];
				const policies = await listOrganizationConnectionAllowedResources(
					db,
					"org",
					ids,
				);
				expect(reads).toHaveBeenCalledTimes(1);
				expect(policies).toHaveLength(152);
				expect(policies.slice(0, 3)).toEqual([
					{ providerId: "git/hub", allowedResources: policy },
					{ providerId: "denied", allowedResources: [] },
					{ providerId: "missing-0", allowedResources: null },
				]);
				reads.mockClear();
				const pairs = [
					"slot",
					"unrestricted",
					"foreign",
					"personal",
					...ids,
				].map((id) => ({ id, providerId: "git/hub" }));
				pairs.push(
					{ id: "slot", providerId: "wrong" },
					{ id: "slot", providerId: "git/hub" },
				);
				const instances = await listOrganizationConnectionInstances(
					db,
					"org",
					pairs,
				);
				expect(reads).toHaveBeenCalledTimes(1);
				expect(instances.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
					{ id: "slot", providerId: "git/hub", allowedResources: policy },
					{ id: "unrestricted", providerId: "git/hub", allowedResources: null },
				]);
				expect(
					await listOrganizationConnectionInstances(db, "org", [
						{ id: "slot", providerId: "wrong" },
					]),
				).toEqual([]);
				await expect(
					listOrganizationConnectionAllowedResources(db, "absent", ids),
				).rejects.toThrow("Organization not found");
				reads.mockClear();
				expect(
					await listOrganizationConnectionAllowedResources(db, "org", []),
				).toEqual([]);
				expect(
					await listOrganizationConnectionInstances(db, "org", []),
				).toEqual([]);
				expect(reads).not.toHaveBeenCalled();
				reads.mockRestore();
			} finally {
				await close();
			}
		}, 30_000);
	});
}
