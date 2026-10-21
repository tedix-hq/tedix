import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { docsBuilds, docsReleases, docsSites } from "../../schema/docs-sites";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { activateDocsBuild, type ActivateDocsBuildParams } from "./releases";
import { getDocsSiteById } from "./sites";

const CREATED_AT = "2001-01-01 00:00:00";
const UPDATED_AT = "2001-01-02 00:00:00";
const ACTOR = {
	type: "external_agent",
	id: "agent-release-test",
	sessionId: "session-release-test",
};
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

async function setup(activeBuildId: string | null = null) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(organizations, docsSites, docsBuilds, docsReleases));
	sqlite.exec("PRAGMA foreign_keys = ON");
	const prepared: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, { onPrepare: (query) => prepared.push(query) }),
	);
	await db.insert(organizations).values({
		id: "org-release-test",
		name: "Release Test",
		slug: "release-test",
		descopeTenantId: "tenant-release-test",
	});
	await db.insert(docsSites).values(
		["site-release", "site-other"].map((id) => ({
			id,
			orgSlug: "release-test",
			slug: id,
			title: "Release Test",
			description: "Local release fixture",
			canonicalUrl: `https://${id}.example`,
			sourceProvider: "artifacts" as const,
			activeBuildId: id === "site-release" ? activeBuildId : null,
			createdAt: CREATED_AT,
			updatedAt: UPDATED_AT,
		})),
	);
	await db.insert(docsBuilds).values([
		...(["complete", "queued", "running", "failed"] as const).map((status) => ({
			id: `build-${status}`,
			siteId: "site-release",
			status,
			phase: status,
		})),
		{ id: "build-old", siteId: "site-release", status: "complete" },
		{ id: "build-other", siteId: "site-other", status: "complete" },
	]);
	const params: ActivateDocsBuildParams = {
		siteId: "site-release",
		orgSlug: "release-test",
		buildId: "build-complete",
		action: "publish",
		actor: ACTOR,
	};
	return { db, sqlite, prepared, params };
}

describe("Docs activation and release receipt atomicity", () => {
	it.each([
		{ action: "publish" as const, previousBuildId: null },
		{ action: "publish" as const, previousBuildId: "build-old" },
		{ action: "rollback" as const, previousBuildId: "build-old" },
	])(
		"rolls back $action from $previousBuildId when the receipt insert fails, then permits retry",
		async ({ action, previousBuildId }) => {
			const { db, sqlite, params } = await setup(previousBuildId);
			params.action = action;
			const before = await getDocsSiteById(db, params.siteId);
			const buildsBefore = await db.select().from(docsBuilds);

			// RAISE(ABORT) cancels this statement only; the facade must undo the
			// preceding site update. The distinct errors prove it ran first.
			sqlite.exec(`
				CREATE TRIGGER fail_release_receipt
				BEFORE INSERT ON docs_releases
				BEGIN
					SELECT CASE WHEN
						(SELECT active_build_id FROM docs_sites WHERE id = NEW.site_id) IS NEW.build_id
						AND (SELECT updated_at FROM docs_sites WHERE id = NEW.site_id) <> '${UPDATED_AT}'
					THEN RAISE(ABORT, 'injected receipt storage failure after site update')
					ELSE RAISE(ABORT, 'receipt executed without successful site update') END;
				END;
			`);
			await expect(activateDocsBuild(db, params)).rejects.toThrow(
				/injected receipt storage failure after site update/,
			);
			expect(await getDocsSiteById(db, params.siteId)).toEqual(before);
			expect(await db.select().from(docsReleases)).toEqual([]);
			expect(await db.select().from(docsBuilds)).toEqual(buildsBefore);

			sqlite.exec("DROP TRIGGER fail_release_receipt");
			const retried = await activateDocsBuild(db, params);
			expect(retried.site.activeBuildId).toBe(params.buildId);
			expect(retried.site.createdAt).toBe(CREATED_AT);
			expect(retried.site.updatedAt).not.toBe(UPDATED_AT);
			expect(retried.release).toMatchObject({
				siteId: params.siteId,
				buildId: params.buildId,
				previousBuildId,
				action,
				actorType: ACTOR.type,
				actorId: ACTOR.id,
				actorSessionId: ACTOR.sessionId,
			});
			expect(await db.select().from(docsReleases)).toEqual([retried.release]);
		},
	);

	it("records the exact previous build and actor for initial publish, replacement and rollback", async () => {
		const { db, params } = await setup();
		const initial = await activateDocsBuild(db, params);
		const replacement = await activateDocsBuild(db, {
			...params,
			buildId: "build-old",
			actor: { type: "user", id: "publisher-test", sessionId: null },
		});
		const rollback = await activateDocsBuild(db, {
			...params,
			action: "rollback",
			actor: {
				type: "tedi",
				id: "rollback-test",
				sessionId: "rollback-session",
			},
		});
		const receipts = [initial, replacement, rollback];
		expect(receipts.map(({ site }) => site.activeBuildId)).toEqual([
			"build-complete",
			"build-old",
			"build-complete",
		]);
		expect(
			receipts.map(({ release }) => ({
				siteId: release.siteId,
				buildId: release.buildId,
				previousBuildId: release.previousBuildId,
				action: release.action,
				actorType: release.actorType,
				actorId: release.actorId,
				actorSessionId: release.actorSessionId,
			})),
		).toEqual([
			{
				siteId: params.siteId,
				buildId: "build-complete",
				previousBuildId: null,
				action: "publish",
				actorType: ACTOR.type,
				actorId: ACTOR.id,
				actorSessionId: ACTOR.sessionId,
			},
			{
				siteId: params.siteId,
				buildId: "build-old",
				previousBuildId: "build-complete",
				action: "publish",
				actorType: "user",
				actorId: "publisher-test",
				actorSessionId: null,
			},
			{
				siteId: params.siteId,
				buildId: "build-complete",
				previousBuildId: "build-old",
				action: "rollback",
				actorType: "tedi",
				actorId: "rollback-test",
				actorSessionId: "rollback-session",
			},
		]);
		expect(new Set(receipts.map(({ release }) => release.id)).size).toBe(3);
		for (const { site, release } of receipts) {
			expect(site.createdAt).toBe(CREATED_AT);
			expect(site.updatedAt).not.toBe(UPDATED_AT);
			expect(release.createdAt).toMatch(
				/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
			);
		}
		expect(await db.select().from(docsReleases)).toEqual(
			expect.arrayContaining(receipts.map(({ release }) => release)),
		);
		expect(await db.select().from(docsReleases)).toHaveLength(3);
		expect(await getDocsSiteById(db, params.siteId)).toEqual(rollback.site);
	});

	it.each([
		{
			name: "missing site",
			override: { siteId: "site-missing" },
			error: /Documentation site not found/,
		},
		{
			name: "wrong organization",
			override: { orgSlug: "another-org" },
			error: /Documentation site not found/,
		},
		{
			name: "missing build",
			override: { buildId: "build-missing" },
			error: /Completed documentation build not found/,
		},
		{
			name: "queued build",
			override: { buildId: "build-queued" },
			error: /Completed documentation build not found/,
		},
		{
			name: "running build",
			override: { buildId: "build-running" },
			error: /Completed documentation build not found/,
		},
		{
			name: "failed build",
			override: { buildId: "build-failed" },
			error: /Completed documentation build not found/,
		},
		{
			name: "wrong-site build",
			override: { buildId: "build-other" },
			error: /Completed documentation build not found/,
		},
		{
			name: "already-active target",
			override: { buildId: "build-old" },
			error: /Documentation build is already active/,
		},
	])("rejects $name without writes", async ({ override, error }) => {
		const { db, sqlite, params, prepared } = await setup("build-old");
		const sitesBefore = await db.select().from(docsSites);
		const buildsBefore = await db.select().from(docsBuilds);
		const changesBefore = sqlite
			.prepare("SELECT total_changes() AS count")
			.get();
		prepared.length = 0;
		await expect(
			activateDocsBuild(db, { ...params, ...override }),
		).rejects.toThrow(error);
		expect(prepared.length).toBeGreaterThan(0);
		expect(prepared.every((query) => /^select\b/i.test(query))).toBe(true);
		expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(
			changesBefore,
		);
		expect(await db.select().from(docsSites)).toEqual(sitesBefore);
		expect(await db.select().from(docsBuilds)).toEqual(buildsBefore);
		expect(await db.select().from(docsReleases)).toEqual([]);
	});
});
