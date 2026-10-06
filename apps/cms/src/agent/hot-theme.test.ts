import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreFenceState,
} from "@tedix/db/queries/cms-restore-fences";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it } from "vite-plus/test";

import {
	hotThemeCssKey,
	hotThemeHistoryKey,
	hotThemeRevisionKey,
	listHotThemeRevisions,
	readHotThemeCss,
	rollbackHotThemeCss,
	themeArtifactRemote,
	writeHotThemeCss,
} from "./hot-theme";

type StoredObject = {
	body: string;
	customMetadata?: Record<string, string>;
	httpEtag: string;
	httpMetadata?: Record<string, string>;
};

function createBucket(onPut?: (key: string) => Promise<void>) {
	const objects = new Map<string, StoredObject>();
	const bucket = {
		async get(key: string) {
			const object = objects.get(key);
			if (!object) return null;
			return {
				customMetadata: object.customMetadata,
				httpEtag: object.httpEtag,
				async json() {
					return JSON.parse(object.body);
				},
				async text() {
					return object.body;
				},
			};
		},
		async put(
			key: string,
			body: string,
			options?: {
				customMetadata?: Record<string, string>;
				httpMetadata?: Record<string, string>;
			},
		) {
			await onPut?.(key);
			objects.set(key, {
				body,
				customMetadata: options?.customMetadata,
				httpEtag: `"${key}:${body.length}"`,
				httpMetadata: options?.httpMetadata,
			});
		},
	};
	return { bucket: bucket as unknown as R2Bucket, objects };
}

function createDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			canonical_url TEXT NOT NULL, custom_domain TEXT, public_path_prefix TEXT,
			template_slug TEXT NOT NULL, config TEXT, mcp_app_id TEXT,
			authoring_app_id TEXT, restore_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		INSERT INTO cms_sites (id, organization_id, slug, name, status, canonical_url,
			template_slug, created_at, updated_at) VALUES
			('site-acme', 'org-acme', 'acme', 'Acme', 'active', 'https://acme.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
			('site-tedix', 'org-tedix', 'tedix', 'Tedix', 'active', 'https://tedix.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
			('site-globex', 'org-globex', 'globex', 'Globex', 'active', 'https://globex.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
			('site-other', 'org-other', 'other', 'Other', 'active', 'https://other.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL,
			capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE cms_deprovision_operations (id TEXT PRIMARY KEY);
		CREATE TABLE cms_restore_permits (
			id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'outer',
			entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE cms_capture_cron_pauses (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL,
			expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER
		);
	`);
	const db = createD1Facade(sqlite);
	return { sqlite, db, queryDb: createDbQueryClient(db) };
}

describe("hot theme revisions", () => {
	it("writes current CSS plus immutable revision history", async () => {
		const { bucket, objects } = createBucket();
		const { sqlite, db } = createDb();
		try {
			const first = await writeHotThemeCss(
				{
					bundlesBucket: bucket,
					db,
					orgSlug: "acme",
				},
				{
					css: ":root { --accent: red; }",
					summary: "Initial hot theme",
				},
			);
			const second = await writeHotThemeCss(
				{
					bundlesBucket: bucket,
					db,
					orgSlug: "acme",
				},
				{
					css: ":root { --accent: blue; }",
					summary: "Blue hot theme",
				},
			);

			expect(await readHotThemeCss(bucket, "acme")).toContain("blue");
			expect(objects.has(hotThemeCssKey("acme"))).toBe(true);
			expect(objects.has(hotThemeHistoryKey("acme"))).toBe(true);
			expect(objects.has(hotThemeRevisionKey("acme", first.revision))).toBe(
				true,
			);
			expect(objects.has(hotThemeRevisionKey("acme", second.revision))).toBe(
				true,
			);

			const history = await listHotThemeRevisions(bucket, "acme");
			expect(history.currentRevision).toBe(second.revision);
			expect(history.revisions.map((entry) => entry.revision)).toEqual([
				second.revision,
				first.revision,
			]);
			expect(second.previousRevision).toBe(first.revision);
			const row = sqlite
				.prepare(
					"SELECT json_extract(config, '$.blog.hotTheme') AS hot_theme FROM cms_sites WHERE slug = 'acme'",
				)
				.get() as { hot_theme: string };
			expect(JSON.parse(row.hot_theme)).toMatchObject({
				historyKey: hotThemeHistoryKey("acme"),
				previousRevision: first.revision,
				publicPath: "/_tedix/theme.css",
				revision: second.revision,
				revisionKey: hotThemeRevisionKey("acme", second.revision),
			});
		} finally {
			sqlite.close();
		}
	});

	it("rolls back current CSS to an existing hot-theme revision", async () => {
		const { bucket } = createBucket();
		const { sqlite, db } = createDb();
		try {
			const ctx = { bundlesBucket: bucket, db, orgSlug: "tedix" };
			const first = await writeHotThemeCss(ctx, {
				css: ".hero { color: red; }",
				summary: "Red",
			});
			const second = await writeHotThemeCss(ctx, {
				css: ".hero { color: blue; }",
				summary: "Blue",
			});

			const rollback = await rollbackHotThemeCss(ctx, {
				revision: first.revision,
				summary: "Rollback to red",
			});

			expect(rollback.revision).toBe(first.revision);
			expect(rollback.previousRevision).toBe(second.revision);
			expect(await readHotThemeCss(bucket, "tedix")).toContain("red");
			const history = await listHotThemeRevisions(bucket, "tedix");
			expect(history.currentRevision).toBe(first.revision);
			expect(history.revisions[0]).toMatchObject({
				revision: first.revision,
				summary: "Rollback to red",
			});
		} finally {
			sqlite.close();
		}
	});

	it("rejects rollback when the revision object is missing", async () => {
		const { bucket, objects } = createBucket();
		const { sqlite, db } = createDb();
		try {
			const ctx = { bundlesBucket: bucket, db, orgSlug: "globex" };
			const first = await writeHotThemeCss(ctx, {
				css: ".card { gap: 1rem; }",
			});
			objects.delete(hotThemeRevisionKey("globex", first.revision));

			await expect(
				rollbackHotThemeCss(ctx, { revision: first.revision }),
			).rejects.toThrow("revision object");
		} finally {
			sqlite.close();
		}
	});

	it("denies both mutations for a fenced site without changing CSS, history, or metadata", async () => {
		const { bucket, objects } = createBucket();
		const { sqlite, db, queryDb } = createDb();
		try {
			const ctx = { bundlesBucket: bucket, db, orgSlug: "acme" };
			const first = await writeHotThemeCss(ctx, {
				css: ".hero { color: red; }",
			});
			const beforeObjects = [...objects.entries()];
			const beforeConfig = sqlite
				.prepare("SELECT config FROM cms_sites WHERE slug = 'acme'")
				.get();
			await closeCmsRestoreFence(queryDb, {
				siteId: "site-acme",
				slug: "acme",
				generation: "g1",
				captureId: "c1",
			});

			await expect(
				writeHotThemeCss(ctx, { css: ".hero { color: blue; }" }),
			).rejects.toThrow("permit denied");
			await expect(
				rollbackHotThemeCss(ctx, { revision: first.revision }),
			).rejects.toThrow("permit denied");
			expect([...objects.entries()]).toEqual(beforeObjects);
			expect(
				sqlite
					.prepare("SELECT config FROM cms_sites WHERE slug = 'acme'")
					.get(),
			).toEqual(beforeConfig);
			expect(
				(
					await getCmsRestoreFenceState(queryDb, {
						siteId: "site-acme",
						slug: "acme",
					})
				).inFlight,
			).toBe(0);

			await expect(
				writeHotThemeCss(
					{ bundlesBucket: bucket, db, orgSlug: "other" },
					{ css: ".hero { color: green; }" },
				),
			).resolves.toMatchObject({ orgSlug: "other" });
			expect(
				(
					await getCmsRestoreFenceState(queryDb, {
						siteId: "site-other",
						slug: "other",
					})
				).inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("holds the permit through R2 writes and releases it after failure", async () => {
		let entered!: () => void;
		const writing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let resume!: () => void;
		const paused = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const { bucket, objects } = createBucket(async (key) => {
			if (key === hotThemeCssKey("acme")) throw new Error("R2 put failed");
			if (!key.startsWith("hot-themes/acme/revisions/")) return;
			entered();
			await paused;
		});
		const { sqlite, db, queryDb } = createDb();
		try {
			const task = writeHotThemeCss(
				{ bundlesBucket: bucket, db, orgSlug: "acme" },
				{ css: ".hero { color: red; }" },
			);
			await writing;
			expect(
				(
					await getCmsRestoreFenceState(queryDb, {
						siteId: "site-acme",
						slug: "acme",
					})
				).inFlight,
			).toBe(1);
			await closeCmsRestoreFence(queryDb, {
				siteId: "site-acme",
				slug: "acme",
				generation: "g1",
				captureId: "c1",
			});
			resume();
			await expect(task).rejects.toThrow("R2 put failed");
			expect(
				(
					await getCmsRestoreFenceState(queryDb, {
						siteId: "site-acme",
						slug: "acme",
					})
				).inFlight,
			).toBe(0);
			expect(
				sqlite
					.prepare("SELECT config FROM cms_sites WHERE slug = 'acme'")
					.get(),
			).toMatchObject({ config: null });
			expect(objects.has(hotThemeCssKey("acme"))).toBe(false);
			await expect(
				writeHotThemeCss(
					{ bundlesBucket: bucket, db, orgSlug: "acme" },
					{ css: ".hero { color: blue; }" },
				),
			).rejects.toThrow("permit denied");
		} finally {
			sqlite.close();
		}
	});
});

describe("themeArtifactRemote", () => {
	it("builds the tenant theme remote without touching a repo handle", () => {
		expect(themeArtifactRemote("acct123", "example-site")).toBe(
			"https://acct123.artifacts.cloudflare.net/git/tedix-prod/cms-theme-example-site.git",
		);
		expect(themeArtifactRemote("acct123", "acme", "other-ns")).toBe(
			"https://acct123.artifacts.cloudflare.net/git/other-ns/cms-theme-acme.git",
		);
	});
});
