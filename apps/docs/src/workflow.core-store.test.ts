import { AsyncResource } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createCoreStore } from "@tedix/db/core-store/client";
import { coreDb, withCoreStore } from "@tedix/db/core-store/scope";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { expect, it, vi } from "vite-plus/test";
import { createBuild, getBuild, upsertSite } from "./registry";
import type { AppBindings } from "./types";
import { DocsBuildWorkflow } from "./workflow";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["d1", "postgres"] as const)(
	"records a preview across detached Workflow steps on %s",
	async (dialect) => {
		const engine = new AsyncResource("workflow-engine");
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const close = vi.fn(async () => {});
		try {
			if (pg) {
				const migrations = fileURLToPath(
					new URL("../../../packages/db/drizzle-pg", import.meta.url),
				);
				for (const directory of readdirSync(migrations).sort())
					await pg.engine.exec(
						readFileSync(join(migrations, directory, "migration.sql"), "utf8"),
					);
				vi.mocked(createCoreStore).mockReturnValue({ db: pg.db, close });
			}
			const seed =
				"INSERT INTO organizations (id,name,slug) VALUES ('docs-org','Docs','docs-org')";
			if (pg) await pg.engine.exec(seed);
			else sqlite!.exec(seed);
			const revision = "a".repeat(40);
			const outputs = [revision, "/index", "built"];
			const sandbox = {
				exec: async () => ({
					output: async () => ({
						stdout: outputs.shift(),
						stderr: "",
						exitCode: 0,
					}),
				}),
				listFiles: async () => [
					{ type: "file", relativePath: "index.html", size: 1 },
				],
				readFile: async () => ({ content: new Uint8Array([42]), size: 1 }),
				deleteFile: vi.fn(async () => {}),
			};
			const env = {
				CORE_STORE: dialect,
				DB: sqlite ? createD1Facade(sqlite) : undefined,
				DOCS_BUILD_SANDBOX: { getByName: () => sandbox },
				DOCS_BUILDS: { put: vi.fn(async () => {}) },
			} as unknown as AppBindings;
			await withCoreStore(env, async () => {
				await upsertSite(env, {
					id: "site",
					orgSlug: "docs-org",
					slug: "reference",
					title: "Docs",
					description: "Fixture",
					locale: "en",
					canonicalUrl: "https://docs.example.test",
					sourceProvider: "github",
					sourceAuthMode: "public",
					repositoryUrl: "https://github.com/example/docs.git",
					artifactsRepository: null,
					branch: "main",
					contentRoot: "docs/public",
					accessMode: "public",
				});
				await createBuild(env, {
					id: "build",
					siteId: "site",
					sourceBranch: "main",
					requestedBy: { type: "service", id: "docs-test", sessionId: null },
				});
			});
			close.mockClear();
			const steps: string[] = [];
			const step = {
				do(name: string, ...args: unknown[]) {
					expect(this).toBe(step);
					steps.push(name);
					const callback = args.at(-1) as () => Promise<unknown>;
					return engine.runInAsyncScope(() => {
						if (pg)
							expect(() => coreDb(env)).toThrow(
								"requires a withCoreStore scope",
							);
						return callback();
					});
				},
			};
			const pending: Promise<unknown>[] = [];
			const result = await DocsBuildWorkflow.prototype.run.call(
				{
					env,
					ctx: {
						waitUntil: (promise: Promise<unknown>) => pending.push(promise),
					},
				} as unknown as DocsBuildWorkflow,
				{ payload: { siteId: "site", buildId: "build" } } as never,
				step as never,
			);
			expect(result).toEqual({ buildId: "build", sourceRevision: revision });
			expect(steps).toEqual(["checkout-build-and-stage", "record-preview"]);
			if (pg) expect(close).toHaveBeenCalledTimes(2);
			await withCoreStore(env, async () => {
				expect(await getBuild(env, "build")).toMatchObject({
					status: "complete",
					sourceRevision: revision,
					manifestKey: "sites/site/builds/build/manifest.json",
				});
			});
			await Promise.all(pending);
			if (pg) expect(close).toHaveBeenCalledTimes(4);
		} finally {
			engine.emitDestroy();
			sqlite?.close();
			await pg?.close();
		}
	},
	30_000,
);
