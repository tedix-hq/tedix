import { AsyncResource } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { createCoreStore } from "@tedix/db/core-store/client";
import { coreQueryDb } from "@tedix/db/core-store/scope";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { expect, it, vi } from "vite-plus/test";
import { DeployWorkflow } from "./deploy-workflow";
import { ImageGenerationWorkflow } from "./image-generation-workflow";
import { withExactCmsSiteRestorePermit } from "./cms-restore-permit";
import { requireUnrestrictedCmsModels } from "./data-residency";
import { mediaUpload } from "./cms-proxy-media";
import { callCmsRest } from "./cms-proxy-rest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));
vi.mock("./cms-restore-permit", () => ({
	CmsUnknownProcessOutcomeError: class extends Error {},
	withExactCmsSiteRestorePermit: vi.fn(),
}));
vi.mock("./theme-candidate", () => ({
	readThemeCandidate: vi.fn(async () => ({
		siteId: "site-example",
		restoreEpoch: 0,
		stagingAttemptId: "snapshot",
		expectedActiveVersion: 1,
	})),
	stageThemeCandidate: vi.fn(async () => ({
		id: "candidate",
		version: 2,
		etag: "etag",
	})),
}));
vi.mock("./deploy-staging", async (original) => ({
	...(await original<typeof import("./deploy-staging")>()),
	cleanupStagedBundle: vi.fn(async () => 1),
}));
vi.mock("./data-residency", () => ({ requireUnrestrictedCmsModels: vi.fn() }));
vi.mock("@tedix/db/queries/tedi-usage", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedi-usage")>()),
	getProviderSpendWindowTotals: vi.fn(async () => ({
		costUsd: 0,
		unpricedCalls: 0,
	})),
	insertCallCosts: vi.fn(),
}));
vi.mock("./cms-proxy-media", () => ({ mediaUpload: vi.fn() }));
vi.mock("./cms-proxy-rest", () => ({ callCmsRest: vi.fn() }));

it.each(["d1", "postgres"] as const)(
	"runs CMS step callbacks after RPC context loss on %s",
	async (dialect) => {
		const engine = new AsyncResource("workflow-engine");
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const close = vi.fn(async () => {});
		try {
			if (pg) {
				const migrations = new URL(
					"../../../../packages/db/drizzle-pg/",
					import.meta.url,
				);
				for (const directory of readdirSync(migrations).sort()) {
					if (!/^\d/.test(directory)) continue;
					const migration = readFileSync(
						new URL(`${directory}/migration.sql`, migrations),
						"utf8",
					);
					for (const sql of migration.split("--> statement-breakpoint"))
						await pg.engine.exec(sql);
				}
				vi.mocked(createCoreStore).mockReturnValue({ db: pg.db, close });
			}
			const seed =
				"INSERT INTO organizations (id,name,slug) VALUES ('org-example','Example','example')";
			if (pg) await pg.engine.exec(seed);
			else sqlite!.exec(seed);
			const env = {
				CORE_STORE: dialect,
				DB: sqlite ? createD1Facade(sqlite) : undefined,
				SITE_BUILDER_STORAGE: { get: async () => null, put: async () => {} },
			};
			const query = async () => {
				expect(
					await getOrganizationBySlug(coreQueryDb(env), "example"),
				).toMatchObject({ id: "org-example" });
			};
			vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
				async (_db, _site, operation) => {
					await query();
					return operation();
				},
			);
			vi.mocked(requireUnrestrictedCmsModels).mockImplementation(query);
			vi.mocked(mediaUpload).mockImplementation(async () => {
				await query();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ id: "media", storage_key: "image.png" }),
						},
					],
				};
			});
			vi.mocked(callCmsRest).mockImplementation(async (_ctx, action) => {
				await query();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								action === "content_get"
									? { data: { item: { id: "item" }, _rev: "rev" } }
									: { success: true },
							),
						},
					],
				};
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({
						candidates: [
							{
								content: {
									parts: [
										{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
									],
								},
							},
						],
					}),
				),
			);
			const steps: string[] = [];
			const step = {
				do: async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					steps.push(name);
					return engine.runInAsyncScope(async () => {
						if (pg)
							expect(() => coreQueryDb(env)).toThrow(
								"requires a withCoreStore scope",
							);
						return callback();
					});
				},
			};
			const pending: Promise<unknown>[] = [];
			const makeWorkflow = <T extends object>(prototype: T): T =>
				Object.assign(Object.create(prototype), {
					env,
					ctx: {
						waitUntil: (promise: Promise<unknown>) => pending.push(promise),
					},
				});
			const deploy = makeWorkflow(DeployWorkflow.prototype);
			expect(
				await deploy.run(
					{
						instanceId: "deploy",
						payload: {
							siteId: "site-example",
							restoreEpoch: 0,
							orgSlug: "example",
							candidateId: "candidate",
							stageOnly: true,
							nextBundleVersion: 2,
							expectedActiveVersion: 1,
						},
					} as never,
					step as never,
				),
			).toMatchObject({ candidateId: "candidate" });
			const image = makeWorkflow(ImageGenerationWorkflow.prototype);
			expect(
				await image.run(
					{
						instanceId: "image",
						payload: {
							orgSlug: "example",
							prompt: "A landscape",
							attachTo: { collection: "posts", id: "item" },
						},
					} as never,
					step as never,
				),
			).toMatchObject({ media: { id: "media" }, attached: { id: "item" } });
			expect(steps).toEqual([
				"load-candidate",
				"stage-candidate",
				"cleanup-staging",
				"load-tenant-image-defaults",
				"generate-image",
				"upload-media",
				"attach-to-content",
			]);
			if (pg) expect(close).toHaveBeenCalledTimes(steps.length);
			if (pg) expect(pending).toHaveLength(2);
		} finally {
			vi.unstubAllGlobals();
			engine.emitDestroy();
			sqlite?.close();
			await pg?.close();
		}
	},
);
