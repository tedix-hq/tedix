import { gzipSync, gunzipSync } from "node:zlib";
import type { CmsBundle } from "@tedix/provisioning/cms-bundle";
import { DatabaseSync } from "node:sqlite";
import {
	activateTenantBundleVersion,
	listTenantBundleVersions,
	uploadTenantBundle,
} from "@tedix/provisioning/cms";
import { describe, expect, it } from "vite-plus/test";

import {
	getCmsBundleDeployGeneration,
	getCmsHumanSiteAuthority,
	inspectCmsHumanAuthActivation,
	getCmsSiteDeployment,
	getCmsTemplateSelection,
	rollbackCmsTenantBundle,
	setCmsHumanAuthActivation,
} from "./storage";

type SqlInputValue = null | number | bigint | string | Uint8Array;

class SqliteD1Statement {
	constructor(
		private readonly sqlite: DatabaseSync,
		readonly sql: string,
		private readonly args: SqlInputValue[] = [],
	) {}

	bind(...args: unknown[]): SqliteD1Statement {
		return new SqliteD1Statement(
			this.sqlite,
			this.sql,
			args as SqlInputValue[],
		);
	}

	async first<T>(): Promise<T | null> {
		return (
			(this.sqlite.prepare(this.sql).get(...this.args) as T | undefined) ?? null
		);
	}

	async all<T>(): Promise<{
		results: T[];
		success: true;
		meta: { changes: number };
	}> {
		const results = this.sqlite.prepare(this.sql).all(...this.args) as T[];
		return { results, success: true, meta: { changes: results.length } };
	}

	async raw<T>(): Promise<T[]> {
		return this.sqlite
			.prepare(this.sql)
			.all(...this.args)
			.map((row) => Object.values(row as Record<string, unknown>)) as T[];
	}

	async run(): Promise<{
		results: never[];
		success: true;
		meta: { changes: number };
	}> {
		const result = this.sqlite.prepare(this.sql).run(...this.args);
		return {
			results: [],
			success: true,
			meta: { changes: Number(result.changes) },
		};
	}

	execute(): { results: unknown[]; success: true; meta: { changes: number } } {
		if (/\bRETURNING\b/i.test(this.sql)) {
			const results = this.sqlite.prepare(this.sql).all(...this.args);
			return { results, success: true, meta: { changes: results.length } };
		}
		const result = this.sqlite.prepare(this.sql).run(...this.args);
		return {
			results: [],
			success: true,
			meta: { changes: Number(result.changes) },
		};
	}
}

function createD1Fixture(withRestorePermitSite = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE tenant_bundles (
		id TEXT PRIMARY KEY,
		slug TEXT NOT NULL,
		version INTEGER NOT NULL,
		r2_prefix TEXT NOT NULL,
		main_module TEXT NOT NULL,
		etag TEXT NOT NULL,
		modules_json TEXT NOT NULL,
		source_revision TEXT,
		is_active INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		deployed_at TEXT,
		deployed_by TEXT,
		summary TEXT,
		UNIQUE(slug, version)
	);
	CREATE TABLE cms_restore_permits (
		id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL,
		restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
		entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`);
	if (withRestorePermitSite) {
		sqlite.exec(`
			CREATE TABLE cms_sites (
				id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
				canonical_url TEXT NOT NULL, custom_domain TEXT, public_path_prefix TEXT,
				template_slug TEXT NOT NULL, config TEXT, mcp_app_id TEXT,
				authoring_app_id TEXT, restore_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			INSERT INTO cms_sites (id, organization_id, slug, name, status, canonical_url,
				template_slug, created_at, updated_at)
			VALUES ('site-acme', 'org-acme', 'acme', 'Acme', 'active',
				'https://acme.example', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			CREATE TABLE cms_restore_fences (
				site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL,
				capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE cms_deprovision_operations (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');
			CREATE TABLE cms_capture_cron_pauses (
				site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL,
				expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER
			);
		`);
	}
	let beforeBatch: (() => void) | undefined;
	const db = {
		prepare(sql: string) {
			return new SqliteD1Statement(sqlite, sql);
		},
		async batch(statements: SqliteD1Statement[]) {
			const hook = beforeBatch;
			beforeBatch = undefined;
			hook?.();
			sqlite.exec("BEGIN");
			try {
				const results = statements.map((statement) => statement.execute());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return {
		db: db as unknown as D1Database,
		sqlite,
		beforeNextBatch(hook: () => void) {
			beforeBatch = hook;
		},
	};
}

function seedBundle(
	sqlite: DatabaseSync,
	version: number,
	isActive: boolean,
	slug = "acme",
): void {
	sqlite
		.prepare(
			`INSERT INTO tenant_bundles
			 (id, slug, version, r2_prefix, main_module, etag, modules_json,
			  is_active, deployed_at, deployed_by)
			 VALUES (?, ?, ?, ?, 'entry.mjs', ?, '["entry.mjs"]', ?, ?, ?)`,
		)
		.run(
			`bundle-${version}`,
			slug,
			version,
			`${slug}/v${version}/`,
			`etag-${version}`,
			isActive ? 1 : 0,
			new Date(2026, 0, version).toISOString(),
			`job-${version}`,
		);
}

function activeVersions(sqlite: DatabaseSync): number[] {
	return (
		sqlite
			.prepare(
				"SELECT version FROM tenant_bundles WHERE slug = 'acme' AND is_active = 1 ORDER BY version",
			)
			.all() as Array<{ version: number }>
	).map((row) => row.version);
}

describe("CMS bundle deploy generation", () => {
	it("remembers an Artifacts source after a later workspace bundle becomes active", async () => {
		const { db, sqlite } = createD1Fixture();
		try {
			seedBundle(sqlite, 1, false);
			seedBundle(sqlite, 2, true);
			sqlite
				.prepare(
					"UPDATE tenant_bundles SET source_revision = ? WHERE slug = 'acme' AND version = 1",
				)
				.run(`artifacts-commit:${"a".repeat(40)}`);
			await expect(getCmsBundleDeployGeneration(db, "acme")).resolves.toEqual({
				activeVersion: 2,
				nextVersion: 3,
				hasArtifactsHistory: true,
			});
			await expect(getCmsBundleDeployGeneration(db, "other")).resolves.toEqual({
				activeVersion: null,
				nextVersion: 1,
				hasArtifactsHistory: false,
			});
		} finally {
			sqlite.close();
		}
	});
});

function unpack(objects: Map<string, Uint8Array>, prefix: string): CmsBundle {
	return JSON.parse(
		gunzipSync(
			objects.get(`${prefix}__tedix_packed_bundle.json.gz`)!,
		).toString(),
	);
}
function setBundleCatalog(
	objects: Map<string, Uint8Array>,
	prefix: string,
	catalog: { mainModule: string; modules: string[] },
) {
	const old = objects.has(`${prefix}__tedix_packed_bundle.json.gz`)
		? unpack(objects, prefix).modules
		: {};
	objects.set(
		`${prefix}__tedix_packed_bundle.json.gz`,
		gzipSync(
			JSON.stringify({
				mainModule: catalog.mainModule,
				modules: Object.fromEntries(
					catalog.modules.map((name) => [name, old[name] ?? { js: "" }]),
				),
			}),
		),
	);
}
function setModule(
	objects: Map<string, Uint8Array>,
	key: string,
	source: string,
) {
	const [, prefix, module] = key.match(/^([^/]+\/v\d+\/)(.+)$/)!;
	const bundle = unpack(objects, prefix!);
	bundle.modules[module!] = { js: source };
	objects.set(
		`${prefix}__tedix_packed_bundle.json.gz`,
		gzipSync(JSON.stringify(bundle)),
	);
}
function getModule(
	objects: Map<string, Uint8Array>,
	key: string,
): string | undefined {
	const [, prefix, module] = key.match(/^([^/]+\/v\d+\/)(.+)$/)!;
	return unpack(objects, prefix!).modules[module!]?.js;
}
function deleteModule(objects: Map<string, Uint8Array>, key: string) {
	const [, prefix, module] = key.match(/^([^/]+\/v\d+\/)(.+)$/)!;
	const bundle = unpack(objects, prefix!);
	delete bundle.modules[module!];
	objects.set(
		`${prefix}__tedix_packed_bundle.json.gz`,
		gzipSync(JSON.stringify(bundle)),
	);
}
function createBucket() {
	const puts: string[] = [];
	const objects = new Map<string, Uint8Array>();
	return {
		puts,
		objects,
		bucket: {
			async put(key: string, value: ArrayBuffer | Uint8Array) {
				puts.push(key);
				objects.set(key, new Uint8Array(value));
			},
			async get(key: string) {
				const value = objects.get(key);
				return value === undefined
					? null
					: new Response(Uint8Array.from(value));
			},
		} as unknown as R2Bucket,
	};
}

function seedCompatibleBundle(
	sqlite: DatabaseSync,
	objects: Map<string, Uint8Array>,
	version: number,
	slug = "acme",
	emdashVersion = "1.0.1",
): void {
	const modules = [
		"entry.mjs",
		"chunks/config_test.mjs",
		"chunks/dialect_test.mjs",
		"chunks/version-test.mjs",
	];
	sqlite
		.prepare(
			"UPDATE tenant_bundles SET modules_json = ? WHERE slug = ? AND version = ?",
		)
		.run(JSON.stringify(modules), slug, version);
	const prefix = `${slug}/v${version}/`;
	setBundleCatalog(objects, `${prefix}`, {
		mainModule: "entry.mjs",
		modules,
	});
	setModule(
		objects,
		`${prefix}chunks/config_test.mjs`,
		`//#region \\0virtual:emdash/config\nvar config_default = { "database": ${JSON.stringify({ type: "sqlite", entrypoint: "/app/src/lib/worker-loader-do-sql-runtime.ts", config: { binding: "DB_DO", name: slug }, supportsRequestScope: true })} };`,
	);
	setModule(
		objects,
		`${prefix}chunks/dialect_test.mjs`,
		`if (binding && typeof binding.query === "function" && typeof binding.batchQuery === "function") return binding;`,
	);
	setModule(
		objects,
		`${prefix}chunks/version-test.mjs`,
		`var VERSION = "${emdashVersion}";`,
	);
}

const bundleFiles = {
	"entry.mjs": new TextEncoder().encode("export default { fetch() {} }"),
	"chunks/version-test.mjs": new TextEncoder().encode('var VERSION = "1.0.1";'),
};
const sourceRevision = {
	kind: "editable_source_digest" as const,
	value: "a".repeat(64),
};

const emittedHumanAuthRoot =
	'import { i as authenticate$1, t as onRequest$8 } from "./chunks/middleware_current.mjs";\nvar authenticate = authenticate$1;\nasync function callAuth(request, authMode) { await authenticate(request, authMode.config); }';
const emittedHumanAuthChunk =
	'async function authenticateHumanAssertion(request, config) {\n\tconst assertion = request.headers.get("X-Tedix-CMS-Human-Assertion");\n\tif (!assertion) return null;\n\tconst runtime = env;\n\tconst keyText = runtime.CMS_HUMAN_AUTH_KEY;\n\tconst siteId = runtime.CMS_HUMAN_AUTH_SITE_ID;\n\tconst bundleEtag = runtime.CMS_HUMAN_AUTH_BUNDLE_ETAG;\n\tif (typeof keyText !== "string" || typeof siteId !== "string" || typeof bundleEtag !== "string") rejectDescopeAuth("human_assertion_disabled", "CMS human assertion is unavailable for this bundle");\n\tconst parts = assertion.split(".");\n\tif (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) rejectDescopeAuth("human_assertion_format", "Invalid CMS human assertion");\n\tconst [payloadText, signatureText] = parts;\n\tlet payload;\n\ttry {\n\t\tconst padded = payloadText.replace(/-/g, "+").replace(/_/g, "/");\n\t\tpayload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));\n\t} catch {\n\t\trejectDescopeAuth("human_assertion_json", "Invalid CMS human assertion");\n\t}\n\tconst key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), {\n\t\tname: "HMAC",\n\t\thash: "SHA-256"\n\t}, false, ["verify"]);\n\tconst signatureBase64 = signatureText.replace(/-/g, "+").replace(/_/g, "/");\n\tlet signature;\n\ttry {\n\t\tsignature = Uint8Array.from(atob(signatureBase64), (char) => char.charCodeAt(0));\n\t} catch {\n\t\trejectDescopeAuth("human_assertion_signature", "Invalid CMS human assertion");\n\t}\n\tif (!await crypto.subtle.verify("HMAC", key, signature.buffer, new TextEncoder().encode(payloadText))) rejectDescopeAuth("human_assertion_signature", "Invalid CMS human assertion");\n\tconst now = Math.floor(Date.now() / 1e3);\n\tconst url = new URL(request.url);\n\tif (payload.siteId !== siteId || payload.bundleEtag !== bundleEtag || payload.slug !== runtime.ORG_SLUG || payload.tenantId !== resolveRequiredTenantId(config) || payload.method !== request.method.toUpperCase() || payload.path !== url.pathname + url.search || typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now + 5 || payload.iat < now - 30 || payload.exp <= now || payload.exp > payload.iat + 30 || ![\n\t\t10,\n\t\t40,\n\t\t50\n\t].includes(payload.role) || typeof payload.subject !== "string" || !payload.subject || typeof payload.email !== "string" || !payload.email || typeof payload.name !== "string" || !payload.name) rejectDescopeAuth("human_assertion_binding", "CMS human assertion is not valid for this request");\n\treturn {\n\t\temail: payload.email,\n\t\tname: payload.name,\n\t\trole: payload.role,\n\t\tsubject: payload.subject,\n\t\tmetadata: {\n\t\t\tdescopeUserId: payload.subject,\n\t\t\tauthProvider: "tedix-cms-human"\n\t\t}\n\t};\n}\nfunction readStringArray() {}\nasync function authenticate(request, config) {\n\tconst descopeConfig = config;\n\tconst internal = authenticateInternalRequest(request, descopeConfig);\n\tif (internal) return internal;\n\tconst assertedHuman = await authenticateHumanAssertion(request, descopeConfig);\n\tif (assertedHuman) return assertedHuman;\n\tconst projectId = resolveProjectId(descopeConfig);\n\tconst baseUrl = resolveBaseUrl(descopeConfig);\n\tconst tokens = extractDescopeTokens(request);\n\tif (!tokens) rejectDescopeAuth("missing_session", "No Descope session token found (Authorization header or DS cookie)");\n\tconst jwks = getJwks(projectId, baseUrl);\n\tlet payload;\n\ttry {\n\t\tpayload = (await jwtVerify(tokens.sessionJwt, jwks, { clockTolerance: 60 })).payload;\n\t} catch (err) {\n\t\tconst msg = err instanceof Error ? err.message : String(err);\n\t\trejectDescopeAuth(`jwt_validation:${err && typeof err === "object" && "code" in err ? String(err.code) : "unknown"}`, `Descope JWT validation failed: ${msg}`);\n\t}\n\ttry {\n\t\tassertDescopeSessionBoundary(payload, {\n\t\t\tbaseUrl,\n\t\t\tprojectId\n\t\t});\n\t} catch (error) {\n\t\tconst message = error instanceof Error ? error.message : String(error);\n\t\trejectDescopeAuth(message.includes("issuer") ? "issuer_mismatch" : "audience_mismatch", message);\n\t}\n\tconst email = payload.email;\n\tif (!email) rejectDescopeAuth("missing_email", "Descope JWT missing email claim");\n\tconst role = resolveDescopeTenantRole(payload, descopeConfig);\n\treturn {\n\t\temail,\n\t\tname: await resolveDisplayName({\n\t\t\tbaseUrl,\n\t\t\temail,\n\t\t\tpayload,\n\t\t\tprojectId,\n\t\t\trefreshJwt: tokens.refreshJwt\n\t\t}),\n\t\trole,\n\t\tsubject: payload.sub,\n\t\tmetadata: {\n\t\t\ttediId: payload.tediId,\n\t\t\tdescopeUserId: payload.descopeUserId,\n\t\t\ttenants: normalizeTenantsClaim(payload.tenants),\n\t\t\tpermissions: payload.permissions\n\t\t}\n\t};\n}\n//#endregion\n//#region node_modules/@standardserver/shared/dist/index.mjs\nexport { authenticate as i };';
function createHumanAuthFixture() {
	const { db, sqlite } = createD1Fixture();
	sqlite.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY, descope_tenant_id TEXT, metadata TEXT);
		CREATE TABLE cms_sites (id TEXT PRIMARY KEY, organization_id TEXT, slug TEXT, status TEXT,
			config TEXT, updated_at TEXT);
		INSERT INTO organizations VALUES ('org-one', 'tenant-owner', '{}');
		INSERT INTO cms_sites VALUES ('site-one', 'org-one', 'acme', 'active',
			'{"blog":{"authDescopeTenantId":"tenant-editorial","defaultLocale":"de"},"branding":{"name":"Acme"}}',
			CURRENT_TIMESTAMP);`);
	seedBundle(sqlite, 1, true);
	const modules = [
		"entry.mjs",
		"virtual_astro_middleware.mjs",
		"chunks/middleware_current.mjs",
	];
	sqlite
		.prepare("UPDATE tenant_bundles SET modules_json = ? WHERE slug = 'acme'")
		.run(JSON.stringify(modules));
	const { bucket, objects } = createBucket();
	setBundleCatalog(objects, "acme/v1/", {
		mainModule: "entry.mjs",
		modules,
	});
	setModule(
		objects,
		"acme/v1/virtual_astro_middleware.mjs",
		emittedHumanAuthRoot,
	);
	setModule(
		objects,
		"acme/v1/chunks/middleware_current.mjs",
		emittedHumanAuthChunk,
	);
	const expected = {
		slug: "acme",
		expectedSiteId: "site-one",
		expectedTenantId: "tenant-editorial",
		expectedVersion: 1,
		expectedBundleEtag: "etag-1",
		expectedCurrentMarker: null,
	};
	return { db, sqlite, bucket, objects, expected };
}

describe("CMS human auth activation", () => {
	it("refuses an oversized shared auth chunk inside the compressed pack", async () => {
		const { db, sqlite, bucket, objects } = createHumanAuthFixture();
		try {
			setModule(
				objects,
				"acme/v1/chunks/middleware_current.mjs",
				" ".repeat(2 * 1024 * 1024 + 1) + emittedHumanAuthChunk,
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({ reason: "human_auth_module_incompatible" });
		} finally {
			sqlite.close();
		}
	});

	it("manual activation resolves reviewed auth only through its immutable catalog-listed chunk", async () => {
		const { db, sqlite, bucket, objects, expected } = createHumanAuthFixture();
		try {
			const module = "chunks/middleware_current.mjs";
			const chunk = getModule(objects, "acme/v1/" + module)!;
			const modules = ["entry.mjs", "virtual_astro_middleware.mjs", module];
			sqlite
				.prepare(
					"UPDATE tenant_bundles SET modules_json = ? WHERE slug = 'acme'",
				)
				.run(JSON.stringify(modules));
			setBundleCatalog(objects, "acme/v1/", {
				mainModule: "entry.mjs",
				modules,
			});
			setModule(
				objects,
				"acme/v1/virtual_astro_middleware.mjs",
				'import { i as authenticate$1 } from "./' +
					module +
					'";\nvar authenticate = authenticate$1;\nasync function callAuth(request, authMode) { await authenticate(request, authMode.config); }',
			);
			setModule(objects, "acme/v1/" + module, chunk);
			expect(
				await inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).toMatchObject({ status: "ready", compatible: true });
			await setCmsHumanAuthActivation(db, bucket, {
				...expected,
				enabled: true,
			});
			setModule(
				objects,
				"acme/v1/" + module,
				chunk.replace("payload.siteId", "payload.otherId"),
			);
			expect(
				await inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).toMatchObject({ reason: "human_auth_module_incompatible" });
		} finally {
			sqlite.close();
		}
	});

	it("reads the exact active bundle capability and CAS enables and disables without losing config", async () => {
		const { db, sqlite, bucket, expected } = createHumanAuthFixture();
		try {
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "ACME"),
			).resolves.toMatchObject({
				status: "ready",
				siteId: "site-one",
				tenantId: "tenant-editorial",
				activeVersion: 1,
				activeBundleEtag: "etag-1",
				humanAssertionBundleEtag: null,
				compatible: true,
			});
			const enabled = await setCmsHumanAuthActivation(db, bucket, {
				...expected,
				enabled: true,
			});
			expect(enabled.humanAssertionBundleEtag).toBe("etag-1");
			const config = sqlite.prepare("SELECT config FROM cms_sites").get() as {
				config: string;
			};
			expect(JSON.parse(config.config)).toEqual({
				blog: {
					authDescopeTenantId: "tenant-editorial",
					defaultLocale: "de",
					humanAssertionBundleEtag: "etag-1",
				},
				branding: { name: "Acme" },
			});
			await expect(
				setCmsHumanAuthActivation(db, bucket, { ...expected, enabled: true }),
			).rejects.toThrow("CAS conflict");
			const disabled = await setCmsHumanAuthActivation(db, bucket, {
				...expected,
				expectedCurrentMarker: "etag-1",
				enabled: false,
			});
			expect(disabled.humanAssertionBundleEtag).toBeNull();
			expect(
				JSON.parse(
					(
						sqlite.prepare("SELECT config FROM cms_sites").get() as {
							config: string;
						}
					).config,
				),
			).toEqual({
				blog: { authDescopeTenantId: "tenant-editorial", defaultLocale: "de" },
				branding: { name: "Acme" },
			});
		} finally {
			sqlite.close();
		}
	});

	it("fails closed on catalog or compiled module drift", async () => {
		const { db, sqlite, bucket, objects, expected } = createHumanAuthFixture();
		try {
			setBundleCatalog(objects, "acme/v1/", {
				mainModule: "entry.mjs",
				modules: ["entry.mjs"],
			});
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "bundle_capability_unreadable",
			});
			await expect(
				setCmsHumanAuthActivation(db, bucket, { ...expected, enabled: true }),
			).rejects.toThrow("CAS conflict");
			setBundleCatalog(objects, "acme/v1/", {
				mainModule: "entry.mjs",
				modules: [
					"entry.mjs",
					"virtual_astro_middleware.mjs",
					"chunks/middleware_current.mjs",
				],
			});
			setModule(
				objects,
				"acme/v1/virtual_astro_middleware.mjs",
				"old auth middleware",
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "human_auth_module_incompatible",
			});
		} finally {
			sqlite.close();
		}
	});

	it("rejects inert signature strings without the reviewed verifier and dispatch", async () => {
		const { db, sqlite, bucket, objects, expected } = createHumanAuthFixture();
		try {
			setModule(
				objects,
				"acme/v1/virtual_astro_middleware.mjs",
				`const dead = ["function authenticateHumanAssertion(", "X-Tedix-CMS-Human-Assertion", "CMS_HUMAN_AUTH_KEY", "CMS_HUMAN_AUTH_SITE_ID", "CMS_HUMAN_AUTH_BUNDLE_ETAG", "crypto.subtle.verify(", "payload.siteId", "payload.bundleEtag", "payload.tenantId", "payload.method", "payload.path", 'authProvider: "tedix-cms-human"'];
				export async function authenticate() { return null; }`,
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "human_auth_module_incompatible",
			});
			await expect(
				setCmsHumanAuthActivation(db, bucket, { ...expected, enabled: true }),
			).rejects.toThrow("CAS conflict");
		} finally {
			sqlite.close();
		}
	});

	it("rejects duplicate verifier anchors in a compiled bundle", async () => {
		const { db, sqlite, bucket, objects } = createHumanAuthFixture();
		try {
			const key = "acme/v1/virtual_astro_middleware.mjs";
			setModule(
				objects,
				key,
				`${getModule(objects, key)!}\n/* async function authenticateHumanAssertion( */`,
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "human_auth_module_incompatible",
			});
		} finally {
			sqlite.close();
		}
	});

	it("replaces a stale marker only after verifying the new active bundle", async () => {
		const { db, sqlite, bucket, objects, expected } = createHumanAuthFixture();
		try {
			sqlite.exec(
				"UPDATE cms_sites SET config = json_set(config, '$.blog.humanAssertionBundleEtag', 'etag-1')",
			);
			sqlite.exec("UPDATE tenant_bundles SET is_active = 0 WHERE version = 1");
			seedBundle(sqlite, 2, true);
			const modules = [
				"entry.mjs",
				"virtual_astro_middleware.mjs",
				"chunks/middleware_current.mjs",
			];
			sqlite
				.prepare("UPDATE tenant_bundles SET modules_json = ? WHERE version = 2")
				.run(JSON.stringify(modules));
			setBundleCatalog(objects, "acme/v2/", {
				mainModule: "entry.mjs",
				modules,
			});
			setModule(
				objects,
				"acme/v2/virtual_astro_middleware.mjs",
				getModule(objects, "acme/v1/virtual_astro_middleware.mjs")!,
			);
			setModule(
				objects,
				"acme/v2/chunks/middleware_current.mjs",
				emittedHumanAuthChunk,
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "stale_activation_marker",
				compatible: true,
				activeVersion: 2,
				activeBundleEtag: "etag-2",
				humanAssertionBundleEtag: "etag-1",
			});
			const next = {
				...expected,
				expectedVersion: 2,
				expectedBundleEtag: "etag-2",
				expectedCurrentMarker: "etag-1",
			};
			await expect(
				setCmsHumanAuthActivation(db, bucket, {
					...next,
					expectedCurrentMarker: null,
					enabled: true,
				}),
			).rejects.toThrow("CAS conflict");
			await expect(
				setCmsHumanAuthActivation(db, bucket, { ...next, enabled: true }),
			).resolves.toMatchObject({
				status: "ready",
				activeVersion: 2,
				humanAssertionBundleEtag: "etag-2",
			});
		} finally {
			sqlite.close();
		}
	});

	it("revokes an exact marker when the compiled verifier is broken", async () => {
		const { db, sqlite, bucket, objects, expected } = createHumanAuthFixture();
		try {
			sqlite.exec(
				"UPDATE cms_sites SET config = json_set(config, '$.blog.humanAssertionBundleEtag', 'etag-1')",
			);
			setModule(
				objects,
				"acme/v1/virtual_astro_middleware.mjs",
				"old auth middleware",
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "human_auth_module_incompatible",
			});
			const current = {
				...expected,
				expectedCurrentMarker: "etag-1",
				enabled: false,
			};
			await expect(
				setCmsHumanAuthActivation(db, bucket, {
					...current,
					expectedCurrentMarker: null,
				}),
			).rejects.toThrow("CAS conflict");
			await expect(
				setCmsHumanAuthActivation(db, bucket, current),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "human_auth_module_incompatible",
				humanAssertionBundleEtag: null,
			});
			expect(
				JSON.parse(
					(
						sqlite.prepare("SELECT config FROM cms_sites").get() as {
							config: string;
						}
					).config,
				),
			).toEqual({
				blog: { authDescopeTenantId: "tenant-editorial", defaultLocale: "de" },
				branding: { name: "Acme" },
			});
		} finally {
			sqlite.close();
		}
	});

	it("rejects missing or duplicate active bundles, paused or retired sites, and stale markers", async () => {
		const { db, sqlite, bucket, expected } = createHumanAuthFixture();
		try {
			sqlite.exec("UPDATE tenant_bundles SET is_active = 0");
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "active_bundle_missing_or_ambiguous",
			});
			sqlite.exec("UPDATE tenant_bundles SET is_active = 1");
			seedBundle(sqlite, 2, true);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "active_bundle_missing_or_ambiguous",
			});
			sqlite.exec("UPDATE tenant_bundles SET is_active = 0 WHERE version = 2");
			sqlite.exec("UPDATE cms_sites SET status = 'paused'");
			await expect(
				setCmsHumanAuthActivation(db, bucket, { ...expected, enabled: true }),
			).rejects.toThrow("CAS conflict");
			sqlite.exec("UPDATE cms_sites SET status = 'active'");
			sqlite.exec(
				'UPDATE organizations SET metadata = \'{"retiredAt":"now"}\'',
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "site_inactive_or_retired",
			});
			sqlite.exec("UPDATE organizations SET metadata = '{}'");
			sqlite.exec(
				"UPDATE cms_sites SET config = json_set(config, '$.blog.humanAssertionBundleEtag', 'old-etag')",
			);
			await expect(
				inspectCmsHumanAuthActivation(db, bucket, "acme"),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: "stale_activation_marker",
			});
		} finally {
			sqlite.close();
		}
	});

	it("CAS refuses an active bundle swap after capability inspection", async () => {
		const { db, sqlite, bucket, expected, objects } = createHumanAuthFixture();
		let swapped = false;
		const racingBucket = {
			get: async (key: string) => {
				const value = objects.get(key);
				if (key.endsWith("__tedix_packed_bundle.json.gz") && !swapped) {
					swapped = true;
					sqlite.exec(
						"UPDATE tenant_bundles SET is_active = 0 WHERE version = 1",
					);
					seedBundle(sqlite, 2, true);
				}
				return value === undefined
					? null
					: new Response(Uint8Array.from(value));
			},
		} as unknown as R2Bucket;
		try {
			await expect(
				setCmsHumanAuthActivation(db, racingBucket, {
					...expected,
					enabled: true,
				}),
			).rejects.toThrow("CAS conflict");
			const marker = sqlite
				.prepare(
					"SELECT json_extract(config, '$.blog.humanAssertionBundleEtag') AS marker FROM cms_sites",
				)
				.get() as { marker: string | null };
			expect(marker.marker).toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it("fences an already-enabled marker against a bundle swap after inspection", async () => {
		const { db, sqlite, expected, objects } = createHumanAuthFixture();
		sqlite.exec(
			"UPDATE cms_sites SET config = json_set(config, '$.blog.humanAssertionBundleEtag', 'etag-1')",
		);
		let swapped = false;
		const racingBucket = {
			get: async (key: string) => {
				const value = objects.get(key);
				if (key.endsWith("__tedix_packed_bundle.json.gz") && !swapped) {
					swapped = true;
					sqlite.exec(
						"UPDATE tenant_bundles SET is_active = 0 WHERE version = 1",
					);
					seedBundle(sqlite, 2, true);
				}
				return value === undefined
					? null
					: new Response(Uint8Array.from(value));
			},
		} as unknown as R2Bucket;
		try {
			await expect(
				setCmsHumanAuthActivation(db, racingBucket, {
					...expected,
					expectedCurrentMarker: "etag-1",
					enabled: true,
				}),
			).rejects.toThrow("CAS conflict");
			const marker = sqlite
				.prepare(
					"SELECT json_extract(config, '$.blog.humanAssertionBundleEtag') AS marker FROM cms_sites",
				)
				.get() as { marker: string | null };
			expect(marker.marker).toBe("etag-1");
		} finally {
			sqlite.close();
		}
	});
});

describe("CMS tenant selection", () => {
	it("uses fresh site, owner, and unique active bundle authority for human access", async () => {
		const { db, sqlite } = createD1Fixture();
		sqlite.exec(`CREATE TABLE organizations (id TEXT, descope_tenant_id TEXT, metadata TEXT);
			CREATE TABLE cms_sites (id TEXT, organization_id TEXT, slug TEXT, status TEXT, config TEXT);
			INSERT INTO organizations VALUES ('org-one', 'tenant-owner', '{}');
			INSERT INTO cms_sites VALUES ('site-one', 'org-one', 'acme', 'active',
			  '{"blog":{"humanAssertionBundleEtag":"etag-1"}}');`);
		try {
			await expect(getCmsHumanSiteAuthority(db, "ACME")).resolves.toBeNull();
			seedBundle(sqlite, 1, true);
			await expect(getCmsHumanSiteAuthority(db, "ACME")).resolves.toEqual({
				siteId: "site-one",
				tenantId: "tenant-owner",
				activeBundleEtag: "etag-1",
				humanAssertionBundleEtag: "etag-1",
			});
			sqlite.exec(`UPDATE cms_sites SET config =
				'{"blog":{"authDescopeTenantId":"tenant-editorial","humanAssertionBundleEtag":"etag-1"}}'`);
			await expect(getCmsHumanSiteAuthority(db, "acme")).resolves.toMatchObject(
				{
					tenantId: "tenant-editorial",
				},
			);
			seedBundle(sqlite, 2, true);
			await expect(getCmsHumanSiteAuthority(db, "acme")).resolves.toBeNull();
			sqlite.exec("UPDATE tenant_bundles SET is_active = 0 WHERE version = 2");
			sqlite.exec("UPDATE cms_sites SET status = 'paused'");
			await expect(getCmsHumanSiteAuthority(db, "acme")).resolves.toBeNull();
			sqlite.exec("UPDATE cms_sites SET status = 'active'");
			sqlite.exec(
				`UPDATE organizations SET metadata = '{"retiredAt":"2026-09-29"}'`,
			);
			await expect(getCmsHumanSiteAuthority(db, "acme")).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("resolves a second site through its owning organization and excludes paused or retired sites", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`CREATE TABLE organizations (id TEXT, slug TEXT, metadata TEXT);
			CREATE TABLE cms_sites (organization_id TEXT, slug TEXT, template_slug TEXT, status TEXT);
			INSERT INTO organizations VALUES ('org-tedix', 'tedix', '{}');
			INSERT INTO cms_sites VALUES ('org-tedix', 'tedix-landing', 'marketing', 'active');`);
		const db = {
			prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
		} as unknown as D1Database;
		try {
			await expect(
				getCmsTemplateSelection(db, "Tedix-Landing"),
			).resolves.toEqual({
				organizationId: "org-tedix",
				blogTemplateSlug: "marketing",
				metaTemplateSlug: null,
			});
			await expect(getCmsTemplateSelection(db, "tedix")).resolves.toBeNull();
			sqlite.exec("UPDATE cms_sites SET status = 'paused'");
			await expect(
				getCmsTemplateSelection(db, "tedix-landing"),
			).resolves.toBeNull();
			sqlite.exec(
				`UPDATE cms_sites SET status = 'active'; UPDATE organizations SET metadata = '{"retiredAt":"2026-09-20"}'`,
			);
			await expect(
				getCmsTemplateSelection(db, "tedix-landing"),
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});
});

describe("CMS site deployment overview", () => {
	it("returns only the selected site's active bundle and preserves legacy null provenance", async () => {
		const { db, sqlite } = createD1Fixture();
		sqlite.exec(`CREATE TABLE cms_sites (slug TEXT, template_slug TEXT, canonical_url TEXT);
			INSERT INTO cms_sites VALUES ('acme', 'marketing', 'https://acme.example');
			INSERT INTO cms_sites VALUES ('other', 'tedix', 'https://other.example');`);
		seedBundle(sqlite, 1, false);
		seedBundle(sqlite, 2, true);
		seedBundle(sqlite, 3, true, "other");
		sqlite
			.prepare(
				"UPDATE tenant_bundles SET source_revision = ? WHERE slug = 'acme' AND version = 2",
			)
			.run(`artifacts-commit:${"a".repeat(40)}`);
		const bucket = {} as R2Bucket;
		try {
			await expect(getCmsSiteDeployment(db, bucket, "acme")).resolves.toEqual({
				templateSlug: "marketing",
				publicUrl: "https://acme.example",
				activeBundleVersion: 2,
				sourceRevision: {
					kind: "artifacts_commit",
					value: "a".repeat(40),
				},
			});
			sqlite.exec(
				"UPDATE tenant_bundles SET source_revision = NULL WHERE slug = 'acme' AND version = 2",
			);
			await expect(
				getCmsSiteDeployment(db, bucket, "acme"),
			).resolves.toMatchObject({
				activeBundleVersion: 2,
				sourceRevision: null,
			});
			await expect(
				getCmsSiteDeployment(db, bucket, "missing"),
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});
});

describe("CMS tenant bundle activation CAS", () => {
	it("activates a compiled direct DO bundle manually", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4, "acme", "0.41.0");

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "unchanged" });
		expect(activeVersions(sqlite)).toEqual([4]);
	});

	it("refuses a legacy rollback target before changing the active bundle", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4);
		setModule(
			objects,
			"acme/v4/chunks/dialect_test.mjs",
			"const stub = binding.get(binding.idFromName('acme')); return stub.query(sql);",
		);

		const manual = await activateTenantBundleVersion(
			{ platformDb: db, bundlesBucket: bucket },
			"acme",
			4,
		);
		expect(manual).toMatchObject({
			success: false,
			error: expect.stringContaining("compiled dialect"),
		});
		const automatic = await rollbackCmsTenantBundle(db, bucket, {
			site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
			failedVersion: 5,
			previousVersion: 4,
		});
		expect(automatic).toMatchObject({
			rolledBack: false,
			error: expect.stringContaining("compiled dialect"),
		});
		expect(activeVersions(sqlite)).toEqual([5]);
	});

	it("refuses Emdash 0.38 rollback even when its database adapter is direct DO", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4, "acme", "0.38.0");

		const manual = await activateTenantBundleVersion(
			{ platformDb: db, bundlesBucket: bucket },
			"acme",
			4,
		);
		expect(manual).toMatchObject({
			success: false,
			error: expect.stringContaining("compiled Emdash 0.38.0"),
		});
		const automatic = await rollbackCmsTenantBundle(db, bucket, {
			site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
			failedVersion: 5,
			previousVersion: 4,
		});
		expect(automatic).toMatchObject({
			rolledBack: false,
			error: expect.stringContaining("compiled Emdash 0.38.0"),
		});
		expect(activeVersions(sqlite)).toEqual([5]);
		expect(Boolean(getModule(objects, "acme/v4/chunks/version-test.mjs"))).toBe(
			true,
		);
	});

	it("reads the release version beside Emdash 1.5's site-settings version chunk", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4, "acme", "1.5.0");
		const modules = [
			"entry.mjs",
			"chunks/config_test.mjs",
			"chunks/dialect_test.mjs",
			"chunks/version-test.mjs",
			"chunks/version-settings.mjs",
		];
		sqlite
			.prepare(
				"UPDATE tenant_bundles SET modules_json = ? WHERE slug = ? AND version = ?",
			)
			.run(JSON.stringify(modules), "acme", 4);
		setBundleCatalog(objects, "acme/v4/", {
			mainModule: "entry.mjs",
			modules,
		});
		setModule(
			objects,
			"acme/v4/chunks/version-settings.mjs",
			"function normalizeSiteSettingsVersion(input) { return input; }",
		);

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "unchanged" });
		expect(activeVersions(sqlite)).toEqual([4]);
	});

	it("refuses an ambiguous compiled Emdash version before rollback", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4);
		setModule(
			objects,
			"acme/v4/chunks/version-test.mjs",
			'var VERSION = "0.42.0"; var VERSION = "0.38.0";',
		);

		const result = await activateTenantBundleVersion(
			{ platformDb: db, bundlesBucket: bucket },
			"acme",
			4,
		);
		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining(
				"compiled Emdash version is missing or ambiguous",
			),
		});
		expect(activeVersions(sqlite)).toEqual([5]);
	});

	it("refuses a missing compiled module before changing the active bundle", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4);
		deleteModule(objects, "acme/v4/chunks/config_test.mjs");

		const result = await activateTenantBundleVersion(
			{ platformDb: db, bundlesBucket: bucket },
			"acme",
			4,
		);
		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining(
				"compressed bundle does not match the catalog",
			),
		});
		expect(activeVersions(sqlite)).toEqual([5]);
	});

	it("rolls a failed active bundle back to the exact predecessor", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4, "acme", "0.42.0");

		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).resolves.toEqual({ rolledBack: true, humanAuthority: "unchanged" });
		expect(activeVersions(sqlite)).toEqual([4]);
	});

	it("does not inspect or activate a rollback target while its site is fenced", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4);
		sqlite.exec(`INSERT INTO cms_restore_fences
			(site_id, slug, generation, capture_id)
			VALUES ('site-acme', 'acme', 'g1', 'c1')`);
		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).rejects.toThrow("permit denied");
		expect(activeVersions(sqlite)).toEqual([5]);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM cms_restore_permits").get(),
		).toMatchObject({ count: 0 });
	});

	it("rejects a queued health rollback after restore release rotates its epoch", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, true);
		seedCompatibleBundle(sqlite, objects, 4);
		// The workflow payload was admitted at epoch zero. A completed restore
		// removes its fence but leaves the site at epoch one.
		sqlite.exec(
			"UPDATE cms_sites SET restore_epoch = 1 WHERE id = 'site-acme'",
		);
		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).rejects.toThrow("permit denied");
		expect(activeVersions(sqlite)).toEqual([5]);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM cms_restore_permits").get(),
		).toMatchObject({ count: 0 });
	});

	it("does not let a stale health rollback replace a newer deployment", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 4, false);
		seedBundle(sqlite, 5, false);
		seedBundle(sqlite, 6, true);
		seedCompatibleBundle(sqlite, objects, 4);

		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).resolves.toEqual({ rolledBack: false });
		expect(activeVersions(sqlite)).toEqual([6]);
	});

	it("keeps the current bundle active when the predecessor is missing", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket } = createBucket();
		seedBundle(sqlite, 5, true);

		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).resolves.toMatchObject({ rolledBack: false });
		expect(activeVersions(sqlite)).toEqual([5]);
	});

	it("publishes the first bundle and reuses its reserved generation on retry", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, puts } = createBucket();
		const upload = {
			orgSlug: "acme",
			mainModule: "entry.mjs",
			files: bundleFiles,
			deployedBy: "cms-deploy-acme-v1",
			version: 1,
			expectedActiveVersion: null,
			sourceRevision,
		};

		const first = await uploadTenantBundle(
			{ bundlesBucket: bucket, platformDb: db },
			upload,
		);
		expect(puts).toEqual(["acme/v1/__tedix_packed_bundle.json.gz"]);
		const putCount = puts.length;
		const replay = await uploadTenantBundle(
			{ bundlesBucket: bucket, platformDb: db },
			upload,
		);

		expect(first.version).toBe(1);
		expect(replay).toEqual(first);
		expect(puts).toHaveLength(putCount);
		expect(activeVersions(sqlite)).toEqual([1]);
	});

	it("publishes a readable compressed pack and refuses activation if its upload fails", async () => {
		for (const fail of [false, true]) {
			const { db, sqlite } = createD1Fixture(true);
			const { bucket } = createBucket();
			let packed: unknown;
			const publication = uploadTenantBundle(
				{
					platformDb: db,
					bundlesBucket: {
						...bucket,
						async put(key: string, value: ArrayBuffer | Uint8Array) {
							if (key.endsWith("__tedix_packed_bundle.json.gz")) {
								if (fail) throw new Error("compressed upload failed");
								packed = await new Response(
									new Response(new Uint8Array(value).buffer).body!.pipeThrough(
										new DecompressionStream("gzip"),
									),
								).json();
							}
							await bucket.put(key, value);
						},
					},
				},
				{
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: bundleFiles,
					sourceRevision,
				},
			);
			if (fail) {
				await expect(publication).rejects.toThrow("compressed upload failed");
				expect(activeVersions(sqlite)).toEqual([]);
			} else {
				await publication;
				expect(packed).toEqual({
					mainModule: "entry.mjs",
					modules: Object.fromEntries(
						Object.entries(bundleFiles).map(([path, bytes]) => [
							path,
							{ js: new TextDecoder().decode(bytes) },
						]),
					),
				});
				expect(activeVersions(sqlite)).toEqual([1]);
			}
			sqlite.close();
		}
	});

	it("rejects Emdash 0.38 upload before reserving or writing files", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, puts } = createBucket();
		await expect(
			uploadTenantBundle(
				{ bundlesBucket: bucket, platformDb: db },
				{
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: {
						...bundleFiles,
						"chunks/version-test.mjs": new TextEncoder().encode(
							'var VERSION = "0.38.0";',
						),
					},
					sourceRevision,
				},
			),
		).rejects.toThrow("compiled Emdash 0.38.0");
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM tenant_bundles").get(),
		).toEqual({ count: 0 });
		expect(puts).toEqual([]);
	});

	it("waits for the only compressed upload and never activates after its failure", async () => {
		const { db, sqlite } = createD1Fixture(true);
		seedBundle(sqlite, 1, true);
		let rejectUpload!: (reason: Error) => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const puts: string[] = [];
		const bucket = {
			put(key: string) {
				puts.push(key);
				markStarted();
				return new Promise<void>((_resolve, reject) => {
					rejectUpload = reject;
				});
			},
		} as unknown as R2Bucket;
		const publication = uploadTenantBundle(
			{ bundlesBucket: bucket, platformDb: db },
			{
				orgSlug: "acme",
				mainModule: "entry.mjs",
				files: bundleFiles,
				version: 2,
				expectedActiveVersion: 1,
				sourceRevision,
			},
		);
		let settled = false;
		void publication.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await started;
		expect(settled).toBe(false);
		expect(activeVersions(sqlite)).toEqual([1]);
		rejectUpload(new Error("compressed upload failed"));
		await expect(publication).rejects.toThrow("compressed upload failed");
		expect(activeVersions(sqlite)).toEqual([1]);
		expect(puts).toEqual(["acme/v2/__tedix_packed_bundle.json.gz"]);
		sqlite.close();
	});

	it("rejects missing module content before starting any R2 put", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket, puts } = createBucket();
		await expect(
			uploadTenantBundle(
				{ bundlesBucket: bucket, platformDb: db },
				{
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: {
						...bundleFiles,
						"chunks/missing.mjs": undefined as unknown as Uint8Array,
					},
					sourceRevision,
				},
			),
		).rejects.toThrow("missing content for chunks/missing.mjs");
		expect(puts).toEqual([]);
		sqlite.close();
	});

	it("leaves a newer bundle active when publish loses its predecessor CAS", async () => {
		const { db, sqlite, beforeNextBatch } = createD1Fixture(true);
		const { bucket } = createBucket();
		seedBundle(sqlite, 1, true);
		beforeNextBatch(() => {
			sqlite
				.prepare("UPDATE tenant_bundles SET is_active = 0 WHERE slug = 'acme'")
				.run();
			seedBundle(sqlite, 3, true);
		});

		await expect(
			uploadTenantBundle(
				{ bundlesBucket: bucket, platformDb: db },
				{
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: bundleFiles,
					deployedBy: "cms-deploy-acme-v2",
					version: 2,
					expectedActiveVersion: 1,
					sourceRevision,
				},
			),
		).rejects.toThrow("compare-and-swap");
		expect(activeVersions(sqlite)).toEqual([3]);
	});

	it("rejects malformed source revisions before reserving a version", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket } = createBucket();

		await expect(
			uploadTenantBundle(
				{ bundlesBucket: bucket, platformDb: db },
				{
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: bundleFiles,
					sourceRevision: {
						kind: "artifacts_commit",
						value: "257f827",
					},
				},
			),
		).rejects.toThrow("full 40-character Git SHA-1");
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM tenant_bundles").get(),
		).toEqual({ count: 0 });
	});

	it("exposes new source identities while leaving legacy versions unknown", async () => {
		const { db, sqlite } = createD1Fixture(true);
		const { bucket } = createBucket();
		seedBundle(sqlite, 1, true);

		await uploadTenantBundle(
			{ bundlesBucket: bucket, platformDb: db },
			{
				orgSlug: "acme",
				mainModule: "entry.mjs",
				files: bundleFiles,
				version: 2,
				expectedActiveVersion: 1,
				sourceRevision,
			},
		);

		const versions = await listTenantBundleVersions(
			{ bundlesBucket: bucket, platformDb: db },
			"acme",
		);
		expect(
			versions.map(({ version, sourceRevision }) => ({
				version,
				sourceRevision,
			})),
		).toEqual([
			{ version: 2, sourceRevision },
			{ version: 1, sourceRevision: null },
		]);
	});

	it("does not let a stale manual rollback replace a newer deployment", async () => {
		const { db, sqlite, beforeNextBatch } = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(sqlite, 1, false);
		seedBundle(sqlite, 2, true);
		seedCompatibleBundle(sqlite, objects, 1);
		beforeNextBatch(() => {
			sqlite
				.prepare("UPDATE tenant_bundles SET is_active = 0 WHERE slug = 'acme'")
				.run();
			seedBundle(sqlite, 3, true);
		});

		const result = await activateTenantBundleVersion(
			{ bundlesBucket: bucket, platformDb: db },
			"acme",
			1,
		);

		expect(result).toEqual({
			success: false,
			error: "version 1 lost a concurrent activation race for acme",
		});
		expect(activeVersions(sqlite)).toEqual([3]);
	});
});

/** A direct-DO-compatible bundle that also ships the compiled human verifier. */
function seedCarryBundle(
	sqlite: DatabaseSync,
	objects: Map<string, Uint8Array>,
	version: number,
	authChunkSource: string,
): void {
	seedCompatibleBundle(sqlite, objects, version, "acme", "1.0.1");
	const prefix = `acme/v${version}/`;
	const bundle = unpack(objects, prefix);
	const modules = [
		...Object.keys(bundle.modules),
		"virtual_astro_middleware.mjs",
		"chunks/middleware_current.mjs",
	];
	sqlite
		.prepare(
			"UPDATE tenant_bundles SET modules_json = ? WHERE slug = 'acme' AND version = ?",
		)
		.run(JSON.stringify(modules), version);
	setBundleCatalog(objects, `${prefix}`, { ...bundle, modules });
	setModule(
		objects,
		`${prefix}virtual_astro_middleware.mjs`,
		emittedHumanAuthRoot,
	);
	setModule(objects, `${prefix}chunks/middleware_current.mjs`, authChunkSource);
}

function siteConfig(sqlite: DatabaseSync): Record<string, unknown> {
	const row = sqlite
		.prepare("SELECT config FROM cms_sites WHERE slug = 'acme'")
		.get() as { config: string };
	return JSON.parse(row.config) as Record<string, unknown>;
}

function markerOf(sqlite: DatabaseSync): unknown {
	return (siteConfig(sqlite).blog as Record<string, unknown>)
		.humanAssertionBundleEtag;
}

describe("CMS human authority carry-forward on bundle activation", () => {
	const reviewedAuthChunk = emittedHumanAuthChunk;
	const baseConfig = JSON.stringify({
		blog: { defaultLocale: "de", humanAssertionBundleEtag: "etag-5" },
		branding: { name: "Acme" },
	});

	function createCarryFixture(config: string | null = baseConfig) {
		const fixture = createD1Fixture(true);
		const { bucket, objects } = createBucket();
		seedBundle(fixture.sqlite, 4, false);
		seedBundle(fixture.sqlite, 5, true);
		fixture.sqlite
			.prepare("UPDATE cms_sites SET config = ? WHERE slug = 'acme'")
			.run(config);
		return { ...fixture, bucket, objects };
	}

	it("carries a live marker onto a new bundle with the reviewed verifier in the activation batch", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture();
		seedCarryBundle(sqlite, objects, 4, reviewedAuthChunk);

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "carried" });
		expect(activeVersions(sqlite)).toEqual([4]);
		expect(siteConfig(sqlite)).toEqual({
			blog: { defaultLocale: "de", humanAssertionBundleEtag: "etag-4" },
			branding: { name: "Acme" },
		});
	});

	it("leaves the marker on the old etag when the new verifier drifts from the reviewed fingerprints", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture();
		seedCarryBundle(
			sqlite,
			objects,
			4,
			reviewedAuthChunk.replace(
				'request.headers.get("X-Tedix-CMS-Human-Assertion")',
				'request.headers.get("X-Drifted-Assertion")',
			),
		);

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "needs_review" });
		expect(activeVersions(sqlite)).toEqual([4]);
		expect(markerOf(sqlite)).toBe("etag-5");
	});

	it("reports needs_review when the new bundle has no verifier module at all", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture();
		seedCompatibleBundle(sqlite, objects, 4, "acme", "1.0.1");

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "needs_review" });
		expect(markerOf(sqlite)).toBe("etag-5");
	});

	it("does not mint a marker when the site never had one", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture(
			JSON.stringify({ blog: { defaultLocale: "de" } }),
		);
		seedCarryBundle(sqlite, objects, 4, reviewedAuthChunk);

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "unchanged" });
		expect(siteConfig(sqlite)).toEqual({ blog: { defaultLocale: "de" } });
	});

	it("leaves an already-stale marker untouched", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture(
			JSON.stringify({
				blog: { defaultLocale: "de", humanAssertionBundleEtag: "etag-3" },
			}),
		);
		seedCarryBundle(sqlite, objects, 4, reviewedAuthChunk);

		await expect(
			activateTenantBundleVersion(
				{ platformDb: db, bundlesBucket: bucket },
				"acme",
				4,
			),
		).resolves.toEqual({ success: true, humanAuthority: "unchanged" });
		expect(markerOf(sqlite)).toBe("etag-3");
	});

	it("does not move the marker when the activation loses its CAS", async () => {
		const { db, sqlite, bucket, objects, beforeNextBatch } =
			createCarryFixture();
		seedCarryBundle(sqlite, objects, 4, reviewedAuthChunk);
		beforeNextBatch(() => {
			seedBundle(sqlite, 6, false);
			sqlite.exec(
				"UPDATE tenant_bundles SET is_active = CASE version WHEN 5 THEN 0 WHEN 6 THEN 1 ELSE is_active END WHERE slug = 'acme'",
			);
		});

		const result = await activateTenantBundleVersion(
			{ platformDb: db, bundlesBucket: bucket },
			"acme",
			4,
		);

		expect(result.success).toBe(false);
		expect(activeVersions(sqlite)).toEqual([6]);
		expect(markerOf(sqlite)).toBe("etag-5");
	});

	it("carries the marker through a theme deploy publish", async () => {
		const { db, sqlite, bucket } = createCarryFixture(
			JSON.stringify({
				blog: { defaultLocale: "de", humanAssertionBundleEtag: "etag-5" },
			}),
		);
		const encoder = new TextEncoder();
		const published = await uploadTenantBundle(
			{ bundlesBucket: bucket, platformDb: db },
			{
				orgSlug: "acme",
				mainModule: "entry.mjs",
				files: {
					...bundleFiles,
					"virtual_astro_middleware.mjs": encoder.encode(emittedHumanAuthRoot),
					"chunks/middleware_current.mjs": encoder.encode(reviewedAuthChunk),
				},
				deployedBy: "cms-deploy-acme-v6",
				version: 6,
				expectedActiveVersion: 5,
				sourceRevision,
			},
		);

		expect(published.humanAuthority).toBe("carried");
		expect(activeVersions(sqlite)).toEqual([6]);
		expect(markerOf(sqlite)).toBe(published.etag);
	});

	it("carries the marker back to the predecessor on a health-check rollback", async () => {
		const { db, sqlite, bucket, objects } = createCarryFixture();
		seedCarryBundle(sqlite, objects, 4, reviewedAuthChunk);

		await expect(
			rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			}),
		).resolves.toEqual({ rolledBack: true, humanAuthority: "carried" });
		expect(activeVersions(sqlite)).toEqual([4]);
		expect(markerOf(sqlite)).toBe("etag-4");
	});
});

it.each(["bundle-retention:tick", "lease:v1:bundle-retention:tick"])(
	"retention permit %s blocks manual and automatic rollback until release",
	async (permitId) => {
		const { db, sqlite } = createD1Fixture(true);
		try {
			const { bucket, objects } = createBucket();
			seedBundle(sqlite, 4, false);
			seedBundle(sqlite, 5, true);
			seedCompatibleBundle(sqlite, objects, 4, "acme", "0.41.0");
			sqlite
				.prepare(
					"INSERT INTO cms_restore_permits (id,site_id,slug,kind) VALUES (?,'site-acme','acme','scheduled')",
				)
				.run(permitId);
			expect(
				await activateTenantBundleVersion(
					{ platformDb: db, bundlesBucket: bucket },
					"acme",
					4,
				),
			).toMatchObject({ success: false });
			expect(activeVersions(sqlite)).toEqual([5]);
			await rollbackCmsTenantBundle(db, bucket, {
				site: { siteId: "site-acme", slug: "acme", restoreEpoch: 0 },
				failedVersion: 5,
				previousVersion: 4,
			});
			expect(activeVersions(sqlite)).toEqual([5]);
			sqlite
				.prepare("DELETE FROM cms_restore_permits WHERE id = ?")
				.run(permitId);
			expect(
				await activateTenantBundleVersion(
					{ platformDb: db, bundlesBucket: bucket },
					"acme",
					4,
				),
			).toMatchObject({ success: true });
			expect(activeVersions(sqlite)).toEqual([4]);
		} finally {
			sqlite.close();
		}
	},
);

it.each(["bundle-retention:tick", "lease:v1:bundle-retention:tick"])(
	"retention permit %s prevents publication with and without a predecessor",
	async (permitId) => {
		for (const predecessor of [null, 1]) {
			const { db, sqlite } = createD1Fixture(true);
			try {
				const { bucket } = createBucket();
				if (predecessor !== null) seedBundle(sqlite, predecessor, true);
				sqlite
					.prepare(
						"INSERT INTO cms_restore_permits (id,site_id,slug,kind) VALUES (?,'site-acme','acme','scheduled')",
					)
					.run(permitId);
				const upload = {
					orgSlug: "acme",
					mainModule: "entry.mjs",
					files: bundleFiles,
					version: 2,
					expectedActiveVersion: predecessor,
					sourceRevision,
				};
				await expect(
					uploadTenantBundle({ bundlesBucket: bucket, platformDb: db }, upload),
				).rejects.toThrow("compare-and-swap");
				expect(activeVersions(sqlite)).toEqual(
					predecessor === null ? [] : [predecessor],
				);
				sqlite
					.prepare("DELETE FROM cms_restore_permits WHERE id = ?")
					.run(permitId);
				await uploadTenantBundle(
					{ bundlesBucket: bucket, platformDb: db },
					upload,
				);
				expect(activeVersions(sqlite)).toEqual([2]);
			} finally {
				sqlite.close();
			}
		}
	},
);
