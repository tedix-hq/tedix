import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import {
	docsBuilds,
	docsChanges,
	docsReleases,
	docsSites,
} from "../../schema/docs-sites";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	completeDocsBuild,
	createDocsBuild,
	getDocsBuild,
	listDocsBuilds,
	updateDocsBuildProgress,
} from "./builds";
import {
	createDocsChange,
	getDocsChange,
	listDocsChanges,
	markDocsChangeCommitted,
	setDocsChangePreview,
	syncDocsChangeValidation,
} from "./changes";
import { activateDocsBuild, listDocsReleases } from "./releases";
import {
	getDocsSiteById,
	getRuntimeDocsSiteBySlug,
	listDocsSites,
	setDocsSiteStatus,
	upsertDocsSite,
} from "./sites";

const actor = { type: "service", id: "docs-test", sessionId: null };
const source = {
	orgSlug: "docs-org",
	title: "Reference",
	description: "Fixture",
	locale: "en",
	canonicalUrl: "https://docs.example.test",
	sourceProvider: "github" as const,
	sourceAuthMode: "public" as const,
	repositoryUrl: "https://github.com/example/docs.git",
	artifactsRepository: null,
	branch: "main",
	contentRoot: "docs/public",
	accessMode: "public" as const,
};

for (const store of ["d1", "postgres"] as const)
	describe(`docs registry core store: ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		let exec: (ddl: string) => void | Promise<unknown>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					schemaDdl(
						organizations,
						docsSites,
						docsBuilds,
						docsChanges,
						docsReleases,
					),
				);
				sqlite.exec("PRAGMA foreign_keys = ON");
				db = createDbQueryClient(createD1Facade(sqlite));
				exec = (ddl) => sqlite.exec(ddl);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				exec = (ddl) => fixture.engine.exec(ddl);
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "docs-org",
					name: "Docs",
					slug: "docs-org",
					descopeTenantId: "docs-tenant",
				},
				{ id: "other-org", name: "Other", slug: "other-org" },
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		async function site(id: string) {
			return upsertDocsSite(db, { ...source, id, slug: id });
		}
		async function ready(siteId: string, id: string) {
			await createDocsBuild(db, {
				id,
				siteId,
				sourceBranch: "main",
				requestedBy: actor,
			});
			await completeDocsBuild(db, {
				buildId: id,
				siteId,
				sourceRevision: "a".repeat(40),
				manifestKey: `${id}.json`,
			});
		}

		it("preserves tenant ownership, build terminality and change CAS through native table bindings", async () => {
			const created = await site("lifecycle");
			expect(created.createdAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
			expect(await getRuntimeDocsSiteBySlug(db, created.slug)).toMatchObject({
				descopeTenantId: "docs-tenant",
			});
			await expect(
				upsertDocsSite(db, {
					...source,
					id: created.id,
					slug: created.slug,
					orgSlug: "other-org",
				}),
			).rejects.toThrow("tenant ownership mismatch");
			expect(await listDocsSites(db, "other-org")).toEqual([]);
			expect(
				await setDocsSiteStatus(db, {
					id: created.id,
					orgSlug: "other-org",
					status: "paused",
				}),
			).toBeNull();
			expect(
				await setDocsSiteStatus(db, {
					id: created.id,
					orgSlug: "docs-org",
					status: "paused",
				}),
			).toMatchObject({ status: "paused" });
			await setDocsSiteStatus(db, {
				id: created.id,
				orgSlug: "docs-org",
				status: "active",
			});
			const batch = vi.spyOn(db, "batch");
			try {
				await createDocsBuild(db, {
					id: "preview",
					siteId: created.id,
					sourceBranch: "proposal",
					requestedBy: actor,
				});
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect(await getDocsSiteById(db, created.id)).toMatchObject({
				latestBuildId: "preview",
			});
			await updateDocsBuildProgress(db, {
				buildId: "preview",
				status: "running",
				phase: "rendering",
			});
			expect(await getDocsBuild(db, "preview")).toMatchObject({
				status: "running",
				startedAt: expect.any(String),
			});
			await completeDocsBuild(db, {
				buildId: "preview",
				siteId: created.id,
				sourceRevision: "original",
				manifestKey: "preview.json",
			});
			const complete = await getDocsBuild(db, "preview");
			await updateDocsBuildProgress(db, {
				buildId: "preview",
				status: "failed",
				phase: "stale",
				error: "stale",
			});
			await completeDocsBuild(db, {
				buildId: "preview",
				siteId: created.id,
				sourceRevision: "stale",
				manifestKey: "stale.json",
			});
			expect(await getDocsBuild(db, "preview")).toEqual(complete);
			expect(await listDocsBuilds(db, created.id)).toEqual([complete]);
			const change = await createDocsChange(db, {
				id: "change",
				siteId: created.id,
				path: "index.md",
				message: "Clarify",
				baseRevision: "base",
				proposalBranch: "proposal",
				proposalRevision: "original",
				contentSha256: "fixture-hash",
				proposedBy: actor,
			});
			await setDocsChangePreview(db, {
				changeId: change.id,
				buildId: "preview",
			});
			expect(await syncDocsChangeValidation(db, change)).toMatchObject({
				status: "validated",
				previewBuildId: "preview",
			});
			const committed = await markDocsChangeCommitted(db, {
				changeId: change.id,
				revision: "merged",
				actor,
			});
			expect(
				await setDocsChangePreview(db, {
					changeId: change.id,
					buildId: "stale",
				}),
			).toEqual(committed);
			expect(await syncDocsChangeValidation(db, change)).toEqual(committed);
			expect(await getDocsChange(db, change.id)).toEqual(committed);
			expect(await listDocsChanges(db, created.id)).toEqual([committed]);
		});

		it("rolls back activation when receipt storage fails and returns the exact successful CAS row on retry", async () => {
			const created = await site("rollback");
			await ready(created.id, "rollback-build");
			const before = await getDocsSiteById(db, created.id);
			await exec(
				store === "d1"
					? `CREATE TRIGGER fail_docs_receipt BEFORE INSERT ON docs_releases BEGIN SELECT RAISE(ABORT, 'injected receipt storage failure'); END`
					: `CREATE FUNCTION fail_docs_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt storage failure'; END $$;
				   CREATE TRIGGER fail_docs_receipt BEFORE INSERT ON docs_releases FOR EACH ROW EXECUTE FUNCTION fail_docs_receipt()`,
			);
			const params = {
				siteId: created.id,
				orgSlug: "docs-org",
				buildId: "rollback-build",
				action: "publish" as const,
				actor,
			};
			try {
				await expect(activateDocsBuild(db, params)).rejects.toThrow();
				expect(await getDocsSiteById(db, created.id)).toEqual(before);
				expect(await listDocsReleases(db, created.id)).toEqual([]);
				if (store === "postgres") {
					const table = coreTable(db, docsSites);
					expect(
						await db
							.select({
								marker: sql<string | null>`${table}.active_release_id`,
							})
							.from(table)
							.where(eq(table.id, created.id)),
					).toEqual([{ marker: null }]);
				}
			} finally {
				await exec(
					store === "d1"
						? "DROP TRIGGER fail_docs_receipt"
						: "DROP TRIGGER fail_docs_receipt ON docs_releases; DROP FUNCTION fail_docs_receipt()",
				);
			}
			const result = await activateDocsBuild(db, params);
			expect(result.site.activeBuildId).toBe(params.buildId);
			expect(result.release).toMatchObject({
				buildId: params.buildId,
				previousBuildId: null,
				actorSessionId: null,
			});
			expect(await getDocsSiteById(db, created.id)).toEqual(result.site);
			expect(await listDocsReleases(db, created.id)).toEqual([result.release]);
			await expect(activateDocsBuild(db, params)).rejects.toThrow(
				"already active",
			);
		});

		it("orders same-time receipts by insertion and rejects delegated release after an intervening publish and rollback", async () => {
			const created = await site("release-order");
			for (const id of ["baseline-build", "manual-build", "delegated-build"])
				await ready(created.id, id);
			const params = {
				siteId: created.id,
				orgSlug: "docs-org",
				buildId: "baseline-build",
				action: "publish" as const,
				actor,
			};
			const baseline = await activateDocsBuild(db, params);
			const manual = await activateDocsBuild(db, {
				...params,
				buildId: "manual-build",
			});
			const rollback = await activateDocsBuild(db, {
				...params,
				action: "rollback",
			});
			const table = coreTable(db, docsReleases);
			await db
				.update(table)
				.set({ createdAt: "2026-01-01 00:00:00" })
				.where(eq(table.siteId, created.id));
			expect(
				(await listDocsReleases(db, created.id)).map((release) => release.id),
			).toEqual([rollback.release.id, manual.release.id, baseline.release.id]);
			await expect(
				activateDocsBuild(db, {
					...params,
					buildId: "delegated-build",
					guard: {
						sourceRevision: "a".repeat(40),
						previousBuildId: "baseline-build",
						previousReleaseId: baseline.release.id,
						canonicalUrl: source.canonicalUrl,
						repositoryUrl: source.repositoryUrl,
					},
				}),
			).rejects.toThrow("concurrent activation race");
			expect(await getDocsSiteById(db, created.id)).toMatchObject({
				activeBuildId: "baseline-build",
			});
			expect(await listDocsReleases(db, created.id)).toHaveLength(3);
		});

		it.skipIf(store !== "postgres")(
			"checks the source-row receipt marker even when the receipt snapshot still matches the delegation",
			async () => {
				const created = await site("source-marker");
				await ready(created.id, "marker-baseline");
				await ready(created.id, "marker-next");
				const params = {
					siteId: created.id,
					orgSlug: "docs-org",
					buildId: "marker-baseline",
					action: "publish" as const,
					actor,
				};
				const baseline = await activateDocsBuild(db, params);
				const guarded = {
					...params,
					buildId: "marker-next",
					guard: {
						sourceRevision: "a".repeat(40),
						previousBuildId: "marker-baseline",
						previousReleaseId: baseline.release.id,
						canonicalUrl: source.canonicalUrl,
						repositoryUrl: source.repositoryUrl,
					},
				};
				const table = coreTable(db, docsSites);
				await db
					.update(table)
					.set({ activeBuildId: "marker-baseline" })
					.where(eq(table.id, created.id));
				expect(
					await db
						.select({ marker: sql<string>`${table}.active_release_id` })
						.from(table)
						.where(eq(table.id, created.id)),
				).toEqual([{ marker: baseline.release.id }]);
				// Model the post-lock source tuple alongside a stale latest-receipt
				// snapshot. This is not a real multi-connection lock-wait measurement.
				await db.run(
					sql`UPDATE ${table} SET active_release_id = 'replacement' WHERE ${table.id} = ${created.id}`,
				);
				await expect(activateDocsBuild(db, guarded)).rejects.toThrow(
					"concurrent activation race",
				);
				expect(await listDocsReleases(db, created.id)).toEqual([
					baseline.release,
				]);
				await db.run(
					sql`UPDATE ${table} SET active_release_id = ${baseline.release.id} WHERE ${table.id} = ${created.id}`,
				);
				const result = await activateDocsBuild(db, guarded);
				expect(result.site).toMatchObject({ activeBuildId: "marker-next" });
				expect(result.site).not.toHaveProperty("active_release_id");
				expect(
					await db.get(
						sql`SELECT active_release_id FROM ${table} WHERE ${table.id} = ${created.id}`,
					),
				).toEqual({ active_release_id: result.release.id });
			},
		);
	});
