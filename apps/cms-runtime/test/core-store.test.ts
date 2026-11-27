import { AsyncResource } from "node:async_hooks";
import type { WorkflowStep } from "cloudflare:workers";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable, type CoreStoreEnv } from "@tedix/db/core-store/client";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { createD1Facade } from "../../../packages/db/src/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { cmsSites } from "../../../packages/db/src/schema/cms-sites";
import { docsSites } from "../../../packages/db/src/schema/docs-sites";
import { organizations } from "../../../packages/db/src/schema/organizations";
import { tenantBundles } from "../../../packages/db/src/schema/tenant-bundles";
import {
	getCmsSiteBySlug,
	setCmsSiteStatus,
} from "@tedix/db/queries/cms-sites";
import {
	cmsDb,
	withCmsCoreStoreSteps,
	cmsQueryDb,
	withCmsCoreStore,
	type CmsCoreStoreEnv,
} from "../src/core-store";
import { readRecoveryAuthority } from "../src/cms-recovery-workflow";
import docsRuntime from "../../docs-runtime/src/index";

const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: (env: CoreStoreEnv) => factory.create(env),
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

for (const store of ["d1", "postgres"] as const) {
	describe(`CMS and docs entrypoints: ${store}`, () => {
		let db: DbClient;
		let env: CmsCoreStoreEnv;
		let close: () => void | Promise<void>;
		const closeScope = vi.fn(async () => {});
		beforeAll(async () => {
			let d1: D1Database;
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				d1 = createD1Facade(sqlite);
				db = createDbClient(d1);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				const migrations = fileURLToPath(
					new URL("../../../packages/db/drizzle-pg", import.meta.url),
				);
				for (const name of readdirSync(migrations).sort()) {
					await fixture.engine.exec(
						readFileSync(`${migrations}/${name}/migration.sql`, "utf8"),
					);
				}
				// Any accidental D1 access must fail on the Postgres path.
				d1 = {
					prepare() {
						throw new Error("Postgres request touched D1");
					},
				} as unknown as D1Database;
				factory.create.mockImplementation(() => ({ db, close: closeScope }));
			}
			env = { PLATFORM_DB: d1, CORE_STORE: store };
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org", slug: "example", name: "Example" });
			await db.insert(coreTable(db, cmsSites)).values({
				id: "site",
				organizationId: "org",
				slug: "example",
				name: "Example",
				canonicalUrl: "https://example.test",
			});
			await db.insert(coreTable(db, tenantBundles)).values({
				id: "bundle",
				slug: "example",
				version: 1,
				r2Prefix: "example/v1/",
				mainModule: "entry.js",
				modulesJson: ["entry.js"],
				etag: "v1",
				isActive: true,
			});
			await db.insert(coreTable(db, docsSites)).values({
				id: "docs",
				orgSlug: "example",
				slug: "handbook",
				title: "Handbook",
				description: "Example",
				canonicalUrl: "https://docs.example.test",
				sourceProvider: "github",
				status: "paused",
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("reads unique recovery authority and persists a site write through the selected store", async () => {
			await withCmsCoreStore(env, async () => {
				const recoveryEnv = { ...env, TENANT_BUNDLES: {} as R2Bucket };
				expect(await readRecoveryAuthority(recoveryEnv, "example")).toEqual({
					siteId: "site",
					bundle: { version: 1, etag: "v1" },
				});
				expect(await readRecoveryAuthority(recoveryEnv, "missing")).toBeNull();
				await setCmsSiteStatus(cmsQueryDb(env), "site", "paused");
				expect((await getCmsSiteBySlug(cmsDb(env), "example"))?.status).toBe(
					"paused",
				);
			});
			if (store === "postgres") expect(closeScope).toHaveBeenCalledTimes(1);
		});

		it("serves the docs registry result through the request scope", async () => {
			const response = await docsRuntime.fetch(
				new Request("https://handbook.docs.example.test/"),
				{
					DB: env.PLATFORM_DB,
					CORE_STORE: store,
					DOCS_BUILDS: {} as R2Bucket,
					ENVIRONMENT: "test",
					GIT_SHA: "test",
					DOCS_BASE_DOMAIN: "docs.example.test",
					DOCS_ROOT_SITE_SLUG: "",
					DOCS_HOST_ALIASES: "{}",
					DESCOPE_PROJECT_ID: "test",
					DESCOPE_BASE_URL: "https://auth.example.test",
				},
			);
			expect(response.status).toBe(503);
			expect(await response.text()).toBe("Documentation site is paused");
			if (store === "postgres") expect(closeScope).toHaveBeenCalledTimes(1);
		});
		it("opens a fresh scope inside detached Workflow callbacks", async () => {
			const detached = new AsyncResource("workflow-step");
			const step = {
				do(_name: string, callback: () => Promise<unknown>) {
					return detached.runInAsyncScope(callback);
				},
			} as unknown as WorkflowStep;
			try {
				await withCmsCoreStore(env, async () => {
					const wrapped = withCmsCoreStoreSteps(env, step);
					await wrapped.do("read-site", async () => {
						expect((await getCmsSiteBySlug(cmsDb(env), "example"))?.id).toBe(
							"site",
						);
						return true;
					});
				});
				if (store === "postgres") expect(closeScope).toHaveBeenCalledTimes(2);
			} finally {
				detached.emitDestroy();
			}
		});
	});
}
