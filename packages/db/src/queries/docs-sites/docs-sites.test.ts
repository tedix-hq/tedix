import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import {
	docsBuilds,
	docsChanges,
	docsReleases,
	docsSites,
} from "../../schema/docs-sites";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
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
	markDocsChangeCommitted,
	setDocsChangePreview,
	syncDocsChangeValidation,
} from "./changes";
import { activateDocsBuild, listDocsReleases } from "./releases";
import {
	getDocsSiteById,
	getDocsSiteBySlug,
	getRuntimeDocsSiteBySlug,
	listDocsSites,
	setDocsSiteStatus,
	upsertDocsSite,
} from "./sites";

const ACTOR = {
	type: "external_agent",
	id: "agent-docs",
	sessionId: "session-docs",
};

interface TestContext {
	db: DbQueryClient;
	sqlite: DatabaseSync;
}

function setup(
	onPrepare?: (query: string, sqlite: DatabaseSync) => void,
): TestContext {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(organizations, docsSites, docsBuilds, docsChanges, docsReleases),
	);
	sqlite
		.prepare(
			"INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES (?, ?, ?, ?)",
		)
		.run("org-docs", "Docs Org", "docs-org", "org_docs");
	const facade = createD1Facade(sqlite, {
		onPrepare: onPrepare
			? (query, raw) => onPrepare(query, raw as DatabaseSync)
			: undefined,
	});
	return { db: createDbQueryClient(facade), sqlite };
}

async function createSite(db: DbQueryClient, id = "site-1") {
	return upsertDocsSite(db, {
		id,
		orgSlug: "docs-org",
		slug: id,
		title: "Tedix Docs",
		description: "Reference",
		locale: "en",
		canonicalUrl: `https://${id}.docs.example`,
		sourceProvider: "github",
		sourceAuthMode: "connection",
		repositoryUrl: "https://github.com/tedix-hq/tedix",
		artifactsRepository: null,
		branch: "main",
		contentRoot: "docs",
		accessMode: "public",
	});
}

describe("docs sites query leaves", () => {
	let context: TestContext;

	beforeEach(() => {
		context = setup();
	});

	it("returns inferred rows and preserves tenant ownership on upsert", async () => {
		const created = await createSite(context.db);
		expect(created.orgSlug).toBe("docs-org");
		expect(created.sourceAuthMode).toBe("connection");
		expect((await getDocsSiteById(context.db, created.id))?.slug).toBe(
			"site-1",
		);
		expect((await getDocsSiteBySlug(context.db, "site-1"))?.id).toBe(
			created.id,
		);
		expect(await listDocsSites(context.db, "docs-org")).toHaveLength(1);

		await expect(
			upsertDocsSite(context.db, {
				...created,
				orgSlug: "another-org",
			}),
		).rejects.toThrow(/tenant ownership mismatch/);
		expect((await getDocsSiteById(context.db, created.id))?.orgSlug).toBe(
			"docs-org",
		);
	});

	it("returns the identity-provider tenant required by the serving edge", async () => {
		const created = await createSite(context.db);
		await expect(
			getRuntimeDocsSiteBySlug(context.db, created.slug),
		).resolves.toEqual({
			id: created.id,
			orgSlug: "docs-org",
			slug: created.slug,
			status: "active",
			accessMode: "public",
			activeBuildId: null,
			descopeTenantId: "org_docs",
		});
	});

	it("archives and restores only a site owned by the requested tenant", async () => {
		const created = await createSite(context.db);
		expect(
			await setDocsSiteStatus(context.db, {
				id: created.id,
				orgSlug: "docs-org",
				status: "paused",
			}),
		).toMatchObject({ status: "paused" });
		expect(
			await setDocsSiteStatus(context.db, {
				id: created.id,
				orgSlug: "another-org",
				status: "active",
			}),
		).toBeNull();
		expect((await getDocsSiteById(context.db, created.id))?.status).toBe(
			"paused",
		);
	});

	it("creates a build and advances the site atomically", async () => {
		const site = await createSite(context.db);
		const build = await createDocsBuild(context.db, {
			siteId: site.id,
			sourceBranch: "main",
			requestedBy: ACTOR,
		});
		expect(build.status).toBe("queued");
		expect((await getDocsSiteById(context.db, site.id))?.latestBuildId).toBe(
			build.id,
		);

		await updateDocsBuildProgress(context.db, {
			buildId: build.id,
			status: "running",
			phase: "rendering",
			sourceRevision: "abc123",
		});
		expect(
			(await getDocsBuild(context.db, build.id))?.startedAt,
		).not.toBeNull();

		await completeDocsBuild(context.db, {
			buildId: build.id,
			siteId: site.id,
			sourceRevision: "abc123",
			manifestKey: "sites/site-1/manifest.json",
		});
		const [complete] = await listDocsBuilds(context.db, site.id);
		expect(complete?.status).toBe("complete");
		expect(complete?.manifestKey).toBe("sites/site-1/manifest.json");
	});

	it("keeps change lifecycle predicates in the persistence owner", async () => {
		const site = await createSite(context.db);
		const build = await createDocsBuild(context.db, {
			siteId: site.id,
			sourceBranch: "proposal/change-1",
			requestedBy: ACTOR,
		});
		const change = await createDocsChange(context.db, {
			id: "change-1",
			siteId: site.id,
			path: "docs/index.md",
			message: "Clarify the introduction",
			baseRevision: "base",
			proposalBranch: "proposal/change-1",
			proposalRevision: "proposal",
			contentSha256: "sha256",
			proposedBy: ACTOR,
		});
		const validating = await setDocsChangePreview(context.db, {
			changeId: change.id,
			buildId: build.id,
		});
		expect(validating.status).toBe("validating");

		await completeDocsBuild(context.db, {
			buildId: build.id,
			siteId: site.id,
			sourceRevision: "proposal",
			manifestKey: "preview.json",
		});
		const validated = await syncDocsChangeValidation(context.db, {
			id: validating.id,
			status: validating.status,
			previewBuildId: validating.previewBuildId,
		});
		expect(validated.status).toBe("validated");

		const committed = await markDocsChangeCommitted(context.db, {
			changeId: change.id,
			revision: "committed",
			actor: ACTOR,
		});
		expect(committed.status).toBe("committed");
		expect((await getDocsChange(context.db, change.id))?.committedById).toBe(
			ACTOR.id,
		);
	});

	it("activates a complete build and records the release in one batch", async () => {
		const site = await createSite(context.db);
		const build = await createDocsBuild(context.db, {
			siteId: site.id,
			sourceBranch: "main",
			requestedBy: ACTOR,
		});
		await completeDocsBuild(context.db, {
			buildId: build.id,
			siteId: site.id,
			sourceRevision: "released",
			manifestKey: "release.json",
		});

		const activated = await activateDocsBuild(context.db, {
			buildId: build.id,
			orgSlug: site.orgSlug,
			siteId: site.id,
			action: "publish",
			actor: ACTOR,
		});
		expect(activated.site.activeBuildId).toBe(build.id);
		expect(activated.release.buildId).toBe(build.id);
		expect(await listDocsReleases(context.db, site.id)).toHaveLength(1);
	});
});

describe("docs release activation CAS", () => {
	it("does not record a release after losing the activation race", async () => {
		let raced = false;
		const context = setup((query, sqlite) => {
			if (
				!raced &&
				query
					.toLowerCase()
					.startsWith('update "docs_sites" set "active_build_id"')
			) {
				raced = true;
				sqlite
					.prepare("UPDATE docs_sites SET active_build_id = ? WHERE id = ?")
					.run("build-competing", "site-race");
			}
		});
		const site = await createSite(context.db, "site-race");
		await context.db.insert(docsBuilds).values([
			{
				id: "build-target",
				siteId: site.id,
				status: "complete",
				phase: "ready",
			},
			{
				id: "build-competing",
				siteId: site.id,
				status: "complete",
				phase: "ready",
			},
		]);

		await expect(
			activateDocsBuild(context.db, {
				buildId: "build-target",
				orgSlug: site.orgSlug,
				siteId: site.id,
				action: "publish",
				actor: ACTOR,
			}),
		).rejects.toThrow(/lost a concurrent activation race/);
		expect(raced).toBe(true);
		expect((await getDocsSiteById(context.db, site.id))?.activeBuildId).toBe(
			"build-competing",
		);
		expect(await listDocsReleases(context.db, site.id)).toEqual([]);
	});
});
