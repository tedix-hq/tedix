import {
	env as workerEnv,
	exports as runtimeExports,
} from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { EmDashDB } from "./emdash-db";
import { digestCmsSiteSqlite } from "./emdash-db";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
	signThemePreview,
	themeCandidateEtag,
	themeCandidateKey,
	THEME_PREVIEW_PATH,
	type CmsThemeCandidate,
} from "@tedix/provisioning/cms-theme-candidate";
import { COMPRESSED_CMS_BUNDLE_KEY } from "@tedix/provisioning/cms-bundle";
import { serveThemePreview, cleanupThemeCandidates } from "./theme-preview";
import { themePreviewEntrypoint } from "./theme-preview-entrypoint";
import { lookupOrg } from "./public-proxy";
import { getCmsRestoreEpoch } from "@tedix/db/queries/cms-restore-fences";
import type { Env } from "./env";
import type { OrgInfo } from "./public-proxy";
import type { ThemePreviewProps } from "./theme-preview-bindings";

vi.mock("./public-proxy", async (original) => ({
	...(await original<typeof import("./public-proxy")>()),
	getDb: vi.fn(),
	lookupOrg: vi.fn(),
}));
vi.mock("@tedix/db/queries/cms-restore-fences", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/cms-restore-fences")>()),
	getCmsRestoreEpoch: vi.fn(),
}));
vi.mock("./tenant-restore-fence", async (original) => ({
	...(await original<typeof import("./tenant-restore-fence")>()),
	withSharedCmsRestorePermit: vi.fn(async (_env, _identity, run) => run()),
}));

const secret = "test-preview-signing-secret";
function fixture() {
	const candidate: CmsThemeCandidate = {
		ready: true,
		id: `cms-test-${crypto.randomUUID()}`,
		siteId: "site-1",
		slug: "acme",
		restoreEpoch: 2,
		sourceCommit: "a".repeat(40),
		version: 7,
		expectedActiveVersion: 6,
		stagingAttemptId: "attempt",
		r2Prefix: "themes/acme/staging/attempt/",
		etag: "b".repeat(64),
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
	};
	const objects = new Map<string, ArrayBuffer | string>([
		[
			themeCandidateKey(candidate.slug, candidate.id),
			JSON.stringify(candidate),
		],
	]);
	const bucket = {
		get: vi.fn(async (key: string) => {
			const value = objects.get(key);
			return value === undefined
				? null
				: {
						body: new Blob([value]).stream(),
						json: async () => JSON.parse(String(value)),
					};
		}),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		})),
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of typeof keys === "string" ? [keys] : keys)
				objects.delete(key);
		}),
		put: vi.fn(async (key: string, value: string) => {
			objects.set(key, value);
		}),
	};
	const org = {
		siteId: candidate.siteId,
		slug: candidate.slug,
		publicSiteUrl: "https://acme.test",
		r2BucketName: "media",
		publicPathPrefix: "",
		siteTitle: "Acme",
		defaultLocale: "en",
	} as OrgInfo;
	vi.mocked(lookupOrg).mockResolvedValue(org);
	vi.mocked(getCmsRestoreEpoch).mockResolvedValue(2);
	const env = {
		LOADER: (workerEnv as unknown as Env).LOADER,
		DB_DO: (workerEnv as unknown as Env).DB_DO,
		TENANT_BUNDLES: bucket,
		CMS_INTERNAL_AUTH_TOKEN: secret,
		ENVIRONMENT: "production",
	} as unknown as Env;
	const url = async (token?: string) =>
		`https://acme.cms.tedix.dev${THEME_PREVIEW_PATH}${candidate.id}/${token ?? (await signThemePreview(secret, candidate))}/`;
	return { candidate, bucket, objects, env, org, url };
}

async function liveDatabase(env: Env, candidate: CmsThemeCandidate) {
	const stub = env.DB_DO.get(
		env.DB_DO.idFromName(candidate.slug),
	) as unknown as DurableObjectStub<EmDashDB>;
	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.deleteAll();
		// Admission itself is covered by the restore-permit tests; keep the SQLite copy real.
		Object.assign(instance, {
			withDatabasePermit: async (
				_identity: unknown,
				run: () => Promise<unknown>,
			) => run(),
		});
	});
	return stub;
}

beforeEach(() => vi.clearAllMocks());

describe("private built theme preview", () => {
	test("renders the retained bundle in its own loader and keeps assets and links private", async () => {
		const { candidate, objects, env, url } = fixture();
		await liveDatabase(env, candidate);
		const source = `export default {fetch(request, env) { if (request.headers.has('cookie') || new URL(request.url).searchParams.has('_preview')) throw new Error('draft auth leaked'); return new Response('<html><head><title>Candidate 7</title><link rel="canonical" href="https://acme.test/"><link rel="stylesheet" href="/_astro/app.css"></head><body>Published content<a href="/about">About</a></body></html>', {headers:{'Content-Type':'text/html'}}); }}`;
		const pack = JSON.stringify({
			mainModule: "entry.mjs",
			modules: { "entry.mjs": { js: source } },
		});
		candidate.etag = await themeCandidateEtag({ "entry.mjs": { js: source } });
		objects.set(
			themeCandidateKey(candidate.slug, candidate.id),
			JSON.stringify(candidate),
		);
		objects.set(
			`${candidate.r2Prefix}${COMPRESSED_CMS_BUNDLE_KEY}`,
			await new Response(
				new Blob([pack]).stream().pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		objects.set(
			`${candidate.r2Prefix}static/app.css`,
			'@font-face {src:url("/_astro/font.woff2")}',
		);
		const previewUrl = await url();
		const render = vi.fn(async (c, org, request) =>
			themePreviewEntrypoint(
				env,
				{ exports: runtimeExports } as unknown as ExecutionContext,
				c,
				org,
			).fetch(request),
		);
		const response = await serveThemePreview(
			new Request(`${previewUrl}?_preview=draft`, {
				headers: { Cookie: "session=owner", Authorization: "Bearer owner" },
			}),
			env,
			render,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
		const html = await response.text();
		expect(html).toContain("<title>Candidate 7</title>");
		expect(html).toContain('rel="canonical" href="https://acme.test/"');
		expect(html).toContain(`${previewUrl}_astro/app.css`);
		expect(html).toContain(`${previewUrl}about`);
		const asset = await serveThemePreview(
			new Request(`${previewUrl}_astro/app.css`),
			env,
			render,
		);
		expect(await asset.text()).toBe(
			`@font-face {src:url("${previewUrl}_astro/font.woff2")}`,
		);
		expect(render).toHaveBeenCalledTimes(1);
	});

	test.each([
		"missing",
		"invalid",
		"expired",
		"other-candidate",
		"other-site",
		"restored",
	])("rejects %s access without invoking the candidate", async (kind) => {
		const { candidate, env, url, objects } = fixture();
		let token = await signThemePreview(
			secret,
			candidate,
			kind === "expired" ? Date.now() - 7_200_000 : Date.now(),
		);
		if (kind === "missing") token = "";
		if (kind === "invalid")
			token = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
		if (kind === "other-candidate" || kind === "other-site") {
			objects.set(
				themeCandidateKey(candidate.slug, candidate.id),
				JSON.stringify({
					...candidate,
					...(kind === "other-candidate"
						? { etag: "c".repeat(64) }
						: { siteId: "site-2" }),
				}),
			);
		}
		if (kind === "restored") vi.mocked(getCmsRestoreEpoch).mockResolvedValue(3);
		const render = vi.fn();
		const response = await serveThemePreview(
			new Request(await url(token)),
			env,
			render,
		);
		expect(response.status).toBe(404);
		expect(render).not.toHaveBeenCalled();
	});

	test("loads island modules and hydrated image props from the candidate", async () => {
		const { candidate, objects, env, url } = fixture();
		const previewUrl = await url();
		const props = JSON.stringify({
			image: [
				0,
				{
					src: [0, "/_astro/new.svg"],
					srcset: [0, "/_astro/new.svg 1x, /_astro/new2.svg 2x"],
					caption: [0, "Unchanged text"],
					external: [0, "https://cdn.test/logo.svg"],
				},
			],
		});
		const render = vi.fn(
			async () =>
				new Response(
					`<astro-island component-url="/_astro/new.js" renderer-url="/_astro/renderer.js" before-hydration-url="/_astro/setup.js" props="${props.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></astro-island>`,
					{ headers: { "Content-Type": "text/html" } },
				),
		);
		const response = await serveThemePreview(
			new Request(previewUrl),
			env,
			render,
		);
		const html = await response.text();
		for (const filename of ["new.js", "renderer.js", "setup.js"]) {
			expect(html).toContain(`${previewUrl}_astro/${filename}`);
			objects.set(
				`${candidate.r2Prefix}static/${filename}`,
				`export default "${filename}"`,
			);
			const asset = await serveThemePreview(
				new Request(`${previewUrl}_astro/${filename}`),
				env,
				render,
			);
			expect(asset.status).toBe(200);
			expect(await asset.text()).toBe(`export default "${filename}"`);
		}
		expect(html).toContain(`${previewUrl}_astro/new.svg`);
		expect(html).toContain(`${previewUrl}_astro/new2.svg`);
		expect(html).toContain("Unchanged text");
		expect(html).toContain("https://cdn.test/logo.svg");
		expect(render).toHaveBeenCalledOnce();
	});

	test("migrates a throwaway copy, renders 200 and leaves every live row and schema unchanged", async () => {
		const { candidate, objects, env, org, url } = fixture();
		const live = await liveDatabase(env, candidate);
		const before = await runInDurableObject(live, (_instance, state) => {
			state.storage.sql.exec(
				"CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
			);
			state.storage.sql.exec(
				"INSERT INTO users VALUES ('owner', 'Published author')",
			);
			state.storage.sql.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY)");
			state.storage.sql.exec("CREATE VIRTUAL TABLE search USING fts5(body)");
			state.storage.sql.exec(
				"INSERT INTO search (rowid, body) VALUES (42, 'Published author')",
			);
			state.storage.sql.exec("CREATE UNIQUE INDEX users_name ON users(name)");
			state.storage.sql.exec(
				"CREATE TABLE byline (author TEXT REFERENCES users(name), body BLOB, upper_author TEXT GENERATED ALWAYS AS (upper(author)) STORED)",
			);
			state.storage.sql.exec(
				"INSERT INTO byline (author, body) VALUES ('Published author', X'0102')",
			);
			state.storage.sql.exec(
				"CREATE TRIGGER prevent_duplicate_copy AFTER INSERT ON users BEGIN INSERT INTO migrations VALUES ('unexpected trigger'); END",
			);
			return digestCmsSiteSqlite(state.storage.sql);
		});
		const source = `export default { async fetch(request, env) {
   if (process.env.EMDASH_MIGRATIONS_MODE !== 'auto' || env.EMDASH_MIGRATIONS_MODE !== 'auto') return new Response('Database migrations are required', {status: 503});
   const applied = await env.DB_DO.query("SELECT name FROM migrations WHERE name = '098_user_last_login'");
   if (applied.rows.length === 0) await env.DB_DO.batchQuery([{sql: 'ALTER TABLE users ADD COLUMN last_login_at TEXT'}, {sql: "INSERT INTO migrations VALUES ('098_user_last_login')"}]);
   const {rows} = await env.DB_DO.query('SELECT name, last_login_at FROM users');
   const byline = await env.DB_DO.query('SELECT upper_author, hex(body) AS body FROM byline');
   if (byline.rows[0].body !== '0102' || byline.rows[0].upper_author !== 'PUBLISHED AUTHOR') throw new Error('byline copy changed');
   const search = await env.DB_DO.query("SELECT body FROM search WHERE search MATCH 'Published' AND rowid = 42");
   return new Response(rows[0].name + ':' + rows[0].last_login_at + ':' + search.rows[0].body, {headers: {'Content-Type': 'text/html'}});
  }};`;
		const modules = { "entry.mjs": { js: source } };
		candidate.etag = await themeCandidateEtag(modules);
		objects.set(
			themeCandidateKey(candidate.slug, candidate.id),
			JSON.stringify(candidate),
		);
		objects.set(
			`${candidate.r2Prefix}${COMPRESSED_CMS_BUNDLE_KEY}`,
			await new Response(
				new Blob([JSON.stringify({ mainModule: "entry.mjs", modules })])
					.stream()
					.pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		const copies: string[] = [];
		const exports = {
			...runtimeExports,
			ThemePreviewDatabase(options: {
				props: ThemePreviewProps & { databaseName: string };
			}) {
				copies.push(options.props.databaseName);
				return (
					runtimeExports as unknown as {
						ThemePreviewDatabase(options: {
							props: ThemePreviewProps & { databaseName: string };
						}): Fetcher;
					}
				).ThemePreviewDatabase(options);
			},
		};
		const render = (
			_candidate: CmsThemeCandidate,
			_org: OrgInfo,
			request: Request,
		) =>
			themePreviewEntrypoint(
				env,
				{ exports } as unknown as ExecutionContext,
				candidate,
				org,
			).fetch(request);
		for (let request = 0; request < 2; request++) {
			const response = await serveThemePreview(
				new Request(await url()),
				env,
				render,
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(
				"Published author:null:Published author",
			);
		}
		expect(copies).toHaveLength(1);
		const copy = env.DB_DO.get(
			env.DB_DO.idFromName(copies[0]!),
		) as unknown as DurableObjectStub<EmDashDB>;
		const copyState = await runInDurableObject(
			copy,
			async (instance, state) => {
				expect(await instance.themePreviewDatabaseInitialized(copies[0]!)).toBe(
					true,
				);
				// Re-initializing skips the marker instead of double-loading rows.
				await instance.initializeThemePreviewDatabase(copies[0]!, [
					{ sql: "CREATE TABLE users (id TEXT PRIMARY KEY)" },
				]);
				return {
					rows: state.storage.sql
						.exec("SELECT name, last_login_at FROM users")
						.toArray(),
					alarm: await state.storage.getAlarm(),
				};
			},
		);
		expect(copyState.rows).toEqual([
			{ name: "Published author", last_login_at: null },
		]);
		expect(copyState.alarm).toBeGreaterThan(Date.now());
		expect(copyState.alarm).toBeLessThanOrEqual(
			Date.parse(candidate.expiresAt),
		);
		expect(
			await runInDurableObject(live, (_instance, state) =>
				digestCmsSiteSqlite(state.storage.sql),
			),
		).toBe(before);
		const rejected = await runInDurableObject(live, async (instance) => {
			const errors: string[] = [];
			for (const operation of [
				() => instance.initializeThemePreviewDatabase(candidate.slug, []),
				() => instance.deleteThemePreviewDatabase(copies[0]!),
			]) {
				try {
					await operation();
				} catch (cause) {
					errors.push((cause as Error).message);
				}
			}
			return errors;
		});
		expect(rejected).toEqual([
			"Not a disposable theme preview database",
			"Not a disposable theme preview database",
		]);
	});

	test("expires candidates and removes only their isolated inputs", async () => {
		const { candidate, objects, bucket } = fixture();
		objects.set(`${candidate.r2Prefix}static/app.css`, "candidate");
		objects.set("acme/v6/bundle", "live");
		objects.set("static/acme/app.css", "live asset");
		await cleanupThemeCandidates(
			bucket as unknown as R2Bucket,
			Date.parse(candidate.expiresAt) + 1,
		);
		expect(objects.has(themeCandidateKey(candidate.slug, candidate.id))).toBe(
			false,
		);
		expect(objects.has(`${candidate.r2Prefix}static/app.css`)).toBe(false);
		expect(objects.get("acme/v6/bundle")).toBe("live");
		expect(objects.get("static/acme/app.css")).toBe("live asset");
	});
});
