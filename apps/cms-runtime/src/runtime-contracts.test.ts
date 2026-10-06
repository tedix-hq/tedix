import { env as workerEnv } from "cloudflare:workers";
import {
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";

import cmsRuntime, {
	canonicalizeSitemapUrls,
	sitemapUsesTrailingSlash,
	TenantEmDashDB,
	TenantRuntimeFailureTail,
	EmDashDB,
	databaseRuntimeAdminResponse,
	databaseDeprovisionAdminResponse,
	databaseStorageAdminResponse,
	databaseRecoveryBookmarkAdminResponse,
	lookupUniqueRecoveryBundle,
	databaseSchemaDiagnosticResponse,
	mediaBucketAdminResponse,
	cmsRecoveryAdminResponse,
	detectBundleDatabaseAdapter,
	isOriginRedirectablePath,
	shouldRedirectCmsOriginRequest,
	isSoftNotFound,
	type DatabaseRuntimeAdminDependencies,
} from "./index";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function acceptingPermitD1(): D1Database {
	return {
		prepare: () => ({
			bind: () => ({ all: async () => ({ results: [{ id: "permit" }] }) }),
		}),
	} as unknown as D1Database;
}

const mediaAdminD1 = (workerEnv as unknown as { PLATFORM_DB: D1Database })
	.PLATFORM_DB;
const mediaAdminDb = createDbQueryClient(mediaAdminD1);

beforeAll(async () => {
	await mediaAdminD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_sites (id TEXT PRIMARY KEY, organization_id TEXT, slug TEXT NOT NULL UNIQUE, name TEXT, description TEXT, status TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, canonical_url TEXT, custom_domain TEXT, public_path_prefix TEXT, template_slug TEXT, config TEXT, mcp_app_id TEXT, authoring_app_id TEXT, created_at TEXT, updated_at TEXT)",
		)
		.run();
	await mediaAdminD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_fences (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL, capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await mediaAdminD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_deprovision_operations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL, authoring_app_id TEXT, status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued', deleted TEXT NOT NULL DEFAULT '[]', errors TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await mediaAdminD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_permits (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'legacy', entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await mediaAdminD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_capture_cron_pauses (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL, expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER)",
		)
		.run();
});

async function mediaAdminSite(
	status: "active" | "paused" | "provisioning" = "active",
) {
	const siteId = crypto.randomUUID();
	const slug = `media-${siteId}`;
	await mediaAdminD1
		.prepare(
			"INSERT INTO cms_sites (id, organization_id, slug, status) VALUES (?, ?, ?, ?)",
		)
		.bind(siteId, "test-org", slug, status)
		.run();
	return { siteId, slug };
}

async function mediaAdminDeprovisionReceipt(siteId: string, slug: string) {
	await mediaAdminD1
		.prepare(
			"INSERT INTO cms_deprovision_operations (id, organization_id, slug, status) VALUES (?, ?, ?, 'running')",
		)
		.bind(siteId, "test-org", slug)
		.run();
}

function mediaAdminRequest(slug: string, intent?: string, siteId?: string) {
	const url = new URL(
		`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
	);
	const headers = new Headers({
		"X-Tedix-CMS-Internal-Auth": "internal-secret",
	});
	if (intent) headers.set("X-Tedix-CMS-Media-Intent", intent);
	if (siteId) headers.set("X-Tedix-CMS-Site-Id", siteId);
	return { url, request: new Request(url, { method: "POST", headers }) };
}

function mediaAdminArgs(
	slug: string,
	intent?: string,
	platformDb: D1Database = mediaAdminD1,
	siteId?: string,
) {
	return {
		accountId: "account",
		env: {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			PLATFORM_DB: platformDb,
		} as never,
		r2Token: "r2-token",
		slug,
		...mediaAdminRequest(slug, intent, siteId),
	};
}

function recoveryPurgeArgs(
	identity: { siteId: string; slug: string },
	options: {
		platformDb?: D1Database;
		onMediaDelete?: () => Promise<void>;
	} = {},
) {
	const captureId = crypto.randomUUID();
	const prefix = `recovery/${identity.siteId}/${captureId}/`;
	const objects = new Map<string, string>([
		[
			`${prefix}control.json`,
			JSON.stringify({
				version: 1,
				...identity,
				captureId,
				createdAt: new Date().toISOString(),
				state: "verified",
			}),
		],
		[`${prefix}manifest.json`, "private manifest"],
		[`${prefix}media/photo.png`, "private media"],
	]);
	const storage = {
		get: vi.fn(async (key: string) => {
			const value = objects.get(key);
			return value === undefined
				? null
				: { json: async () => JSON.parse(value) };
		}),
		put: vi.fn(async (key: string, value: string) => {
			objects.set(key, value);
			return {};
		}),
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				if (key.endsWith("/media/photo.png")) await options.onMediaDelete?.();
				objects.delete(key);
			}
		}),
		list: vi.fn(async () => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
		})),
	};
	const url = new URL(
		`https://${identity.slug}.cms.tedix.dev/_tedix/internal/database-runtime/recovery-captures`,
	);
	url.searchParams.set("siteId", identity.siteId);
	url.searchParams.set("captureId", captureId);
	return {
		prefix,
		storage,
		objects,
		args: {
			env: {
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				PLATFORM_DB: options.platformDb ?? mediaAdminD1,
				RECOVERY_STORAGE: storage,
				CMS_RECOVERY_WORKFLOW: {
					get: async () => {
						throw new Error("expired Workflow history");
					},
				},
			} as never,
			request: new Request(url, {
				method: "DELETE",
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
			}),
			slug: identity.slug,
			url,
		},
	};
}

describe("CMS recovery capture purge admission", () => {
	test("a current archived site retains purge access", async () => {
		const identity = await mediaAdminSite("paused");
		const harness = recoveryPurgeArgs(identity);
		expect((await cmsRecoveryAdminResponse(harness.args))?.status).toBe(200);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
	});

	test("an admitted purge drains before an exact-site restore fence releases", async () => {
		const identity = await mediaAdminSite();
		let finish!: () => void;
		const reachedMedia = Promise.withResolvers<void>();
		const harness = recoveryPurgeArgs(identity, {
			onMediaDelete: async () => {
				reachedMedia.resolve();
				await new Promise<void>((resolve) => (finish = resolve));
			},
		});
		const pending = cmsRecoveryAdminResponse(harness.args);
		await reachedMedia.promise;
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(1);
		const fence = {
			...identity,
			generation: crypto.randomUUID(),
			captureId: crypto.randomUUID(),
		};
		expect(await closeCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(false);
		finish();
		expect((await pending)?.status).toBe(200);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
	});

	test("a closed restore fence denies purge before any recovery storage read", async () => {
		const identity = await mediaAdminSite();
		// A real close requires an active site; archive it only after close.
		const fence = {
			...identity,
			generation: crypto.randomUUID(),
			captureId: crypto.randomUUID(),
		};
		expect(await closeCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
		await mediaAdminD1
			.prepare("UPDATE cms_sites SET status = 'paused' WHERE id = ?")
			.bind(identity.siteId)
			.run();
		const harness = recoveryPurgeArgs(identity);
		const denied = await cmsRecoveryAdminResponse(harness.args);
		expect(denied?.status).toBe(409);
		expect(harness.storage.get).not.toHaveBeenCalled();
		expect(harness.storage.delete).not.toHaveBeenCalled();
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
	});

	test("unavailable D1 denies purge before any recovery storage read", async () => {
		const identity = await mediaAdminSite();
		const brokenD1 = {
			prepare: () => {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const harness = recoveryPurgeArgs(identity, { platformDb: brokenD1 });
		const denied = await cmsRecoveryAdminResponse(harness.args);
		expect(denied?.status).toBe(503);
		expect(harness.storage.get).not.toHaveBeenCalled();
		expect(harness.storage.delete).not.toHaveBeenCalled();
	});

	test("a removed site purges only with its succeeded deprovision receipt", async () => {
		const identity = {
			siteId: crypto.randomUUID(),
			slug: `old-${crypto.randomUUID()}`,
		};
		const missingReceipt = recoveryPurgeArgs(identity);
		expect((await cmsRecoveryAdminResponse(missingReceipt.args))?.status).toBe(
			409,
		);
		expect(missingReceipt.storage.get).not.toHaveBeenCalled();
		await mediaAdminD1
			.prepare(
				"INSERT INTO cms_deprovision_operations (id, organization_id, slug, status) VALUES (?, 'test-org', ?, 'succeeded')",
			)
			.bind(identity.siteId, identity.slug)
			.run();
		await mediaAdminD1
			.prepare(
				"INSERT INTO cms_sites (id, organization_id, slug, status) VALUES (?, 'test-org', ?, 'active')",
			)
			.bind(crypto.randomUUID(), identity.slug)
			.run();
		const harness = recoveryPurgeArgs(identity);
		expect((await cmsRecoveryAdminResponse(harness.args))?.status).toBe(200);
		expect([...harness.objects.keys()]).toEqual([
			`${harness.prefix}control.json`,
		]);
	});
});

describe("dynamic tenant failure tail", () => {
	test("records child error logs when response metadata is absent", async () => {
		const errorLog = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const tail = Object.assign(
			Object.create(TenantRuntimeFailureTail.prototype),
			{ ctx: { props: { slug: "tenant" } } },
		) as TenantRuntimeFailureTail;
		const event = {
			event: null,
			exceptions: [],
			logs: [
				{
					level: "error",
					message: "private page content",
					errorInfo: [
						{
							name: "TypeError",
							message: "private error detail",
							stack:
								"TypeError: private error detail\n    at render (src/page.ts:12:3)",
						},
					],
				},
			],
			outcome: "ok",
			wallTime: 123,
		} as unknown as TraceItem;

		await TenantRuntimeFailureTail.prototype.tail.call(tail, [event]);
		expect(errorLog).toHaveBeenCalledWith(
			"[cms-runtime] tenant worker failure",
			expect.objectContaining({
				tenant: "tenant",
				status: undefined,
				errorLogs: [{ name: "TypeError", frame: "render @ src/page.ts:12:3" }],
			}),
		);
		const output = JSON.stringify(errorLog.mock.calls);
		expect(output).not.toContain("private page content");
		expect(output).not.toContain("private error detail");
	});

	test("records failure shape without request or error content", async () => {
		const errorLog = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const tail = Object.assign(
			Object.create(TenantRuntimeFailureTail.prototype),
			{ ctx: { props: { slug: "tenant" } } },
		) as TenantRuntimeFailureTail;
		const event = {
			event: {
				request: { url: "https://tenant.cms.tedix.dev/private-secret" },
				response: { status: 503 },
			},
			exceptions: [
				{
					name: "TypeError",
					message: "credential-secret",
					stack:
						"TypeError: credential-secret\n    at render (src/page.ts:12:3)",
				},
			],
			logs: [
				{
					level: "error",
					message: "tenant-content-secret",
					errorInfo: [
						{
							name: "Error",
							message: "log-secret",
							stack: "Error: log-secret\n    at fetch (src/db.ts:7:2)",
						},
					],
				},
			],
			outcome: "ok",
			wallTime: 123,
		} as unknown as TraceItem;

		await TenantRuntimeFailureTail.prototype.tail.call(tail, [event]);
		expect(errorLog).toHaveBeenCalledWith(
			"[cms-runtime] tenant worker failure",
			expect.objectContaining({
				tenant: "tenant",
				status: 503,
				exceptions: [{ name: "TypeError", frame: "render @ src/page.ts:12:3" }],
				errorLogs: [{ name: "Error", frame: "fetch @ src/db.ts:7:2" }],
			}),
		);
		const output = JSON.stringify(errorLog.mock.calls);
		for (const secret of [
			"private-secret",
			"credential-secret",
			"tenant-content-secret",
			"log-secret",
		]) {
			expect(output).not.toContain(secret);
		}
	});
});

describe("CMS media bucket administration", () => {
	test("serves internal cleanup before active-site lookup", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					success: true,
					result: { name: "bucket" },
					errors: [],
				}),
			),
		);
		const response = await cmsRuntime.fetch(
			new Request("https://tenant.cms.tedix.dev/_tedix/internal/media-bucket", {
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
			}),
			{
				ENVIRONMENT: "production",
				CF_ACCOUNT_ID: "account",
				CLOUDFLARE_R2_API_TOKEN: "r2-token",
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				// No PLATFORM_DB: tenant lookup would fail if it ran before cleanup.
			} as never,
			{} as never,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			exists: true,
		});
	});

	test("inspects and creates through the runtime R2 credential for an exact provisioning site", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ success: false, result: null, errors: [{ message: "not found" }] },
					{ status: 404 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ success: false, result: null, errors: [{ message: "not found" }] },
					{ status: 404 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ success: true, result: {}, errors: [] }),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: { name: "bucket" },
					errors: [],
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const { siteId, slug } = await mediaAdminSite("provisioning");
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			PLATFORM_DB: mediaAdminD1,
		} as never;
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
		);

		const inspected = await mediaBucketAdminResponse({
			accountId: "account",
			env,
			r2Token: "r2-token",
			request: new Request(url, {
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
			}),
			slug,
			url,
		});
		expect(await inspected?.json()).toMatchObject({
			success: true,
			exists: false,
		});

		const repaired = await mediaBucketAdminResponse(
			mediaAdminArgs(slug, "create", mediaAdminD1, siteId),
		);
		expect(await repaired?.json()).toMatchObject({
			success: true,
			exists: true,
			created: true,
		});
		expect(fetch.mock.calls[2]?.[1]).toMatchObject({
			method: "POST",
		});
	});

	test("requires a valid creation or repair intent before any provider call", async () => {
		const identity = await mediaAdminSite();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const intent of [undefined, "other", "create"]) {
			const response = await mediaBucketAdminResponse(
				mediaAdminArgs(identity.slug, intent, mediaAdminD1, identity.siteId),
			);
			expect(response?.status).toBe(intent === "create" ? 503 : 400);
		}
		const paused = await mediaAdminSite("paused");
		const pausedResponse = await mediaBucketAdminResponse(
			mediaAdminArgs(paused.slug, "repair", mediaAdminD1, paused.siteId),
		);
		expect(pausedResponse?.status).toBe(409);
		const missingResponse = await mediaBucketAdminResponse(
			mediaAdminArgs(
				`missing-${crypto.randomUUID()}`,
				"repair",
				mediaAdminD1,
				crypto.randomUUID(),
			),
		);
		expect(missingResponse?.status).toBe(409);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("requires an exact site ID for creation and repair", async () => {
		const { siteId, slug } = await mediaAdminSite("provisioning");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const intent of ["create", "repair"]) {
			expect(
				(await mediaBucketAdminResponse(mediaAdminArgs(slug, intent)))?.status,
			).toBe(400);
			expect(
				(
					await mediaBucketAdminResponse(
						mediaAdminArgs(slug, intent, mediaAdminD1, crypto.randomUUID()),
					)
				)?.status,
			).toBe(409);
		}
		expect(siteId).toBeTruthy();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("creation holds the exact site permit until R2 returns", async () => {
		const identity = await mediaAdminSite("provisioning");
		let finish!: () => void;
		let created = false;
		const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				await new Promise<void>((resolve) => (finish = resolve));
				created = true;
				return Response.json({ success: true, result: {}, errors: [] });
			}
			if (created)
				return Response.json({
					success: true,
					result: { name: "bucket" },
					errors: [],
				});
			return Response.json(
				{ success: false, result: null, errors: [{ message: "not found" }] },
				{ status: 404 },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const pending = mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "create", mediaAdminD1, identity.siteId),
		);
		await vi.waitFor(async () => {
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(
				(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
			).toBe(1);
		});
		finish();
		expect((await pending)?.status).toBe(200);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
	});

	test("definite creation failure releases the permit", async () => {
		const identity = await mediaAdminSite("provisioning");
		const fetch = vi.fn(async (_input: string, init?: RequestInit) =>
			Response.json(
				{
					success: false,
					result: null,
					errors: [
						{ message: init?.method === "POST" ? "denied" : "not found" },
					],
				},
				{ status: init?.method === "POST" ? 403 : 404 },
			),
		);
		vi.stubGlobal("fetch", fetch);
		const failed = await mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "create", mediaAdminD1, identity.siteId),
		);
		expect(failed?.status).toBe(502);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
	});

	test("unobserved creation outcome leaves an orphan permit", async () => {
		for (const outcome of ["transport", "invalid-json", "invalid-shape"]) {
			const identity = await mediaAdminSite("provisioning");
			const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					if (outcome === "transport") throw new Error("connection reset");
					if (outcome === "invalid-shape") return Response.json({});
					return new Response("incomplete JSON", { status: 200 });
				}
				return Response.json(
					{ success: false, result: null, errors: [{ message: "not found" }] },
					{ status: 404 },
				);
			});
			vi.stubGlobal("fetch", fetch);
			const failed = await mediaBucketAdminResponse(
				mediaAdminArgs(identity.slug, "create", mediaAdminD1, identity.siteId),
			);
			expect(failed?.status).toBe(502);
			expect(await failed?.json()).toMatchObject({
				success: false,
				error: "R2 bucket creation outcome unknown",
			});
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(
				(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
			).toBe(1);
		}
	});

	test("repair permit drains provider work and a closed site denies another repair", async () => {
		const identity = await mediaAdminSite();
		let finish!: () => void;
		const fetch = vi.fn(async () => {
			await new Promise<void>((resolve) => (finish = resolve));
			return Response.json({ success: true, result: {}, errors: [] });
		});
		vi.stubGlobal("fetch", fetch);
		const pending = mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "repair", mediaAdminD1, identity.siteId),
		);
		await vi.waitFor(async () => {
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(
				(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
			).toBe(1);
		});
		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(false);
		const denied = await mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "repair", mediaAdminD1, identity.siteId),
		);
		expect(denied?.status).toBe(503);
		expect(denied?.headers.get("Cache-Control")).toBe("no-store");
		expect(fetch).toHaveBeenCalledTimes(1);
		finish();
		expect((await pending)?.status).toBe(200);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
	});

	test("provider failure releases repair permit while another site stays isolated", async () => {
		const identity = await mediaAdminSite();
		const other = await mediaAdminSite();
		const fence = { ...other, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
		const fetch = vi
			.fn()
			.mockResolvedValue(
				Response.json(
					{ success: false, result: null, errors: [{ message: "failed" }] },
					{ status: 500 },
				),
			);
		vi.stubGlobal("fetch", fetch);
		const failed = await mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "repair", mediaAdminD1, identity.siteId),
		);
		expect(failed?.status).toBe(502);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(0);
		const denied = await mediaBucketAdminResponse(
			mediaAdminArgs(other.slug, "repair", mediaAdminD1, other.siteId),
		);
		expect(denied?.status).toBe(503);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await releaseCmsRestoreFence(mediaAdminDb, fence)).toBe(true);
	});

	test("unobserved repair create outcome retains the active-site permit", async () => {
		const identity = await mediaAdminSite();
		const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") throw new Error("connection reset");
			return Response.json(
				{ success: false, result: null, errors: [{ message: "not found" }] },
				{ status: 404 },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const failed = await mediaBucketAdminResponse(
			mediaAdminArgs(identity.slug, "repair", mediaAdminD1, identity.siteId),
		);
		expect(failed?.status).toBe(502);
		expect(
			(await getCmsRestoreFenceState(mediaAdminDb, identity)).inFlight,
		).toBe(1);
	});

	test("unreadable D1 denies creation and repair before provider work", async () => {
		const identity = await mediaAdminSite();
		const brokenD1 = {
			prepare: () => {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const intent of ["create", "repair"]) {
			const response = await mediaBucketAdminResponse(
				mediaAdminArgs(identity.slug, intent, brokenD1, identity.siteId),
			);
			expect(response?.status).toBe(503);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	test("rejects requests without internal authorization", async () => {
		const url = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/media-bucket",
		);
		const response = await mediaBucketAdminResponse({
			accountId: "account",
			env: { CMS_INTERNAL_AUTH_TOKEN: "internal-secret" } as never,
			r2Token: "r2-token",
			request: new Request(url),
			slug: "tenant",
			url,
		});
		expect(response?.status).toBe(401);
	});

	test("empties and deletes a tenant media bucket with the runtime R2 credential", async () => {
		const { siteId, slug } = await mediaAdminSite("paused");
		await mediaAdminDeprovisionReceipt(siteId, slug);
		const fetch = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/objects?per_page=1000"))
				return Response.json({ success: true, result: [], errors: [] });
			return Response.json({ success: true, result: {}, errors: [] });
		});
		vi.stubGlobal("fetch", fetch);
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
		);
		const response = await mediaBucketAdminResponse({
			accountId: "account",
			env: {
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				PLATFORM_DB: mediaAdminD1,
			} as never,
			r2Token: "r2-token",
			request: new Request(url, {
				method: "DELETE",
				headers: {
					"X-Tedix-CMS-Internal-Auth": "internal-secret",
					"X-Tedix-CMS-Site-Id": siteId,
				},
			}),
			slug,
			url,
		});
		expect(await response?.json()).toMatchObject({
			success: true,
			deleted: true,
		});
		expect(
			fetch.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1]
				?.headers,
		).toMatchObject({ Authorization: "Bearer r2-token" });
	});

	test("rejects media deletion without exact site and running receipt", async () => {
		const { siteId, slug } = await mediaAdminSite("paused");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
		);
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			PLATFORM_DB: mediaAdminD1,
		} as never;
		const deletion = (headerSiteId?: string) =>
			mediaBucketAdminResponse({
				accountId: "account",
				env,
				r2Token: "r2-token",
				request: new Request(url, {
					method: "DELETE",
					headers: {
						"X-Tedix-CMS-Internal-Auth": "internal-secret",
						...(headerSiteId ? { "X-Tedix-CMS-Site-Id": headerSiteId } : {}),
					},
				}),
				slug,
				url,
			});
		expect((await deletion())?.status).toBe(400);
		expect((await deletion(crypto.randomUUID()))?.status).toBe(409);
		expect((await deletion(siteId))?.status).toBe(409);
		await mediaAdminDeprovisionReceipt(siteId, "different-slug");
		expect((await deletion(siteId))?.status).toBe(409);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("CMS database deprovisioning", () => {
	test("reads only protected schema diagnostics without tenant content", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ name: "id" }, { name: "content" }] })
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValueOnce({ rows: [{ total: 10 }] })
			.mockResolvedValueOnce({ rows: [{ state: "active" }] })
			.mockResolvedValueOnce({
				rows: [
					{
						capture_state: "inactive",
						status: "stale",
						change_epoch: 3,
						last_error_code: "CONTENT_USAGE_STALE",
						collection_matches: 1,
					},
				],
			})
			.mockResolvedValueOnce({
				rows: [
					{ name: "change_epoch" },
					{ name: "reconciliation_required" },
					{ name: "updated_at" },
				],
			});
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			DB_DO: { idFromName: (name: string) => name, get: () => ({ query }) },
		};
		const url = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/schema-diagnostic",
		);
		const request = new Request(url, {
			headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
		});
		const response = await databaseSchemaDiagnosticResponse({
			env: env as never,
			request,
			slug: "tenant",
			url,
		});
		expect(await response?.json()).toMatchObject({
			pagesTablePresent: true,
			contentColumnPresent: true,
			contentFieldPresent: false,
			activeMarketingBlockVersionCount: 10,
			mediaUsageActivationState: "active",
			pagesMediaUsageCaptureState: "inactive",
			pagesMediaUsageChangeEpoch: 3,
			pagesMediaUsageLastErrorCode: "CONTENT_USAGE_STALE",
			pagesMediaUsageCollectionMatches: true,
			pagesMediaUsageIndexColumnsPresent: true,
		});
		expect(query).toHaveBeenCalledTimes(6);
		const denied = await databaseSchemaDiagnosticResponse({
			env: env as never,
			request: new Request(url),
			slug: "tenant",
			url,
		});
		expect(denied?.status).toBe(401);
		expect(query).toHaveBeenCalledTimes(6);
	});

	test("inspects storage read-only for paused tenants with internal authorization", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ name: "ec_posts" }] })
			.mockResolvedValueOnce({ rows: [] });
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			DB_DO: { idFromName: (name: string) => name, get: () => ({ query }) },
		};
		const url = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/storage",
		);
		const request = new Request(url, {
			headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
		});
		const present = await databaseStorageAdminResponse({
			env: env as never,
			request,
			slug: "tenant",
			url,
		});
		expect(await present?.json()).toMatchObject({ storageState: "present" });
		const missing = await databaseStorageAdminResponse({
			env: env as never,
			request,
			slug: "tenant",
			url,
		});
		expect(await missing?.json()).toMatchObject({ storageState: "missing" });
		expect(query).toHaveBeenCalledTimes(2);
		const denied = await databaseStorageAdminResponse({
			env: env as never,
			request: new Request(url),
			slug: "tenant",
			url,
		});
		expect(denied?.status).toBe(401);
	});

	test("captures a primary bookmark only for existing CMS storage and an active bundle", async () => {
		const captureRecoveryBookmark = vi.fn().mockResolvedValue("bookmark-1");
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			DB_DO: {
				idFromName: (name: string) => name,
				get: () => ({ captureRecoveryBookmark }),
			},
		};
		const url = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/recovery-bookmark",
		);
		const request = new Request(url, {
			method: "POST",
			headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
		});
		const bundle = { slug: "tenant", version: 84, etag: "bundle-etag" };
		const readCurrentBundle = vi.fn().mockResolvedValue(bundle);
		const args = {
			env: env as never,
			request,
			slug: "tenant",
			url,
			siteId: "site-1",
			bundle,
			readCurrentBundle,
		};
		const denied = await databaseRecoveryBookmarkAdminResponse({
			...args,
			request: new Request(url, { method: "POST" }),
		});
		expect(denied?.status).toBe(401);
		const wrongBundle = await databaseRecoveryBookmarkAdminResponse({
			...args,
			bundle: { ...bundle, slug: "other" } as never,
		});
		expect(wrongBundle?.status).toBe(409);
		expect(captureRecoveryBookmark).not.toHaveBeenCalled();
		const captured = await databaseRecoveryBookmarkAdminResponse(args);
		expect(captured?.status).toBe(200);
		expect(captured?.headers.get("Cache-Control")).toBe("no-store");
		expect(await captured?.json()).toMatchObject({
			ok: true,
			siteId: "site-1",
			slug: "tenant",
			bundle: { version: 84, etag: "bundle-etag" },
			bookmark: "bookmark-1",
		});
		readCurrentBundle.mockResolvedValueOnce({
			...bundle,
			etag: "replacement-etag",
		});
		const raced = await databaseRecoveryBookmarkAdminResponse(args);
		expect(raced?.status).toBe(409);
		expect(raced?.headers.get("Cache-Control")).toBe("no-store");
		readCurrentBundle.mockResolvedValueOnce(null);
		const duplicateAfterCapture =
			await databaseRecoveryBookmarkAdminResponse(args);
		expect(duplicateAfterCapture?.status).toBe(409);
		captureRecoveryBookmark.mockResolvedValueOnce(null);
		const missing = await databaseRecoveryBookmarkAdminResponse(args);
		expect(missing?.status).toBe(409);
	});

	test("recovery bundle lookup rejects duplicate active rows", async () => {
		const all = vi
			.fn()
			.mockResolvedValueOnce({
				results: [
					{ version: 83, etag: "old", isActive: 1 },
					{ version: 84, etag: "new", isActive: 1 },
				],
			})
			.mockResolvedValueOnce({
				results: [
					{ version: 83, etag: "old", isActive: 0 },
					{ version: 84, etag: "new", isActive: 1 },
				],
			});
		const env = {
			PLATFORM_DB: { prepare: () => ({ bind: () => ({ all }) }) },
			TENANT_BUNDLES: {},
		};
		expect(await lookupUniqueRecoveryBundle(env as never, "tenant")).toBeNull();
		expect(await lookupUniqueRecoveryBundle(env as never, "tenant")).toEqual({
			slug: "tenant",
			version: 84,
			etag: "new",
		});
		expect(all).toHaveBeenCalledTimes(2);
	});

	test("does not resolve an active site or touch a Durable Object for a public bookmark request", async () => {
		const idFromName = vi.fn();
		const response = await cmsRuntime.fetch(
			new Request(
				"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/recovery-bookmark",
				{ method: "POST" },
			),
			{
				ENVIRONMENT: "production",
				CF_ACCOUNT_ID: "account",
				CLOUDFLARE_R2_API_TOKEN: "r2-token",
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				DB_DO: { idFromName },
				// No PLATFORM_DB: authentication must run before site lookup.
			} as never,
			{} as never,
		);
		expect(response.status).toBe(401);
		expect(idFromName).not.toHaveBeenCalled();
	});

	test("the recovery bookmark RPC forwards replicas and refuses empty primary storage", async () => {
		const primary = vi.fn().mockResolvedValue("primary-bookmark");
		const replicaBookmark =
			await EmDashDB.prototype.captureRecoveryBookmark.call({
				ctx: { storage: { primary: { captureRecoveryBookmark: primary } } },
			} as unknown as EmDashDB);
		expect(replicaBookmark).toBe("primary-bookmark");
		const getCurrentBookmark = vi.fn().mockResolvedValue("primary-bookmark");
		const exec = vi
			.fn()
			.mockReturnValueOnce({ toArray: () => [] })
			.mockReturnValueOnce({
				toArray: () => [{ name: "ec_posts" }],
			})
			.mockReturnValueOnce({
				toArray: () => [{ name: "options" }],
			});
		const object = {
			ctx: { storage: { sql: { exec }, getCurrentBookmark } },
		} as unknown as EmDashDB;
		expect(
			await EmDashDB.prototype.captureRecoveryBookmark.call(object),
		).toBeNull();
		expect(getCurrentBookmark).not.toHaveBeenCalled();
		expect(await EmDashDB.prototype.captureRecoveryBookmark.call(object)).toBe(
			"primary-bookmark",
		);
		expect(await EmDashDB.prototype.captureRecoveryBookmark.call(object)).toBe(
			"primary-bookmark",
		);
		expect(getCurrentBookmark).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[0]?.[0]).toContain("'options'");
	});

	test("recovery snapshot forwards the entire SQLite and bookmark read to primary", async () => {
		const snapshot = {
			bookmark: "primary-bookmark",
			databaseDigest: "a".repeat(64),
		};
		const primary = vi.fn().mockResolvedValue(snapshot);
		const blockConcurrencyWhile = vi.fn();
		const result = await EmDashDB.prototype.captureRecoverySnapshot.call({
			ctx: {
				storage: { primary: { captureRecoverySnapshot: primary } },
				blockConcurrencyWhile,
			},
		} as unknown as EmDashDB);
		expect(result).toEqual(snapshot);
		expect(primary).toHaveBeenCalledOnce();
		expect(blockConcurrencyWhile).not.toHaveBeenCalled();
	});

	test("recovery snapshot couples synchronous full digest to bookmark within one block", async () => {
		const events: string[] = [];
		const rows = (items: Array<Record<string, unknown>>) => ({
			[Symbol.iterator]: () => items[Symbol.iterator](),
			toArray: () => items,
		});
		const sql = {
			databaseSize: 1024,
			exec(statement: string) {
				if (statement.includes("LIMIT 1")) return rows([{ name: "ec_posts" }]);
				if (statement.startsWith("SELECT type, name, tbl_name, sql")) {
					events.push("digest");
					return rows([
						{
							type: "table",
							name: "ec_posts",
							tbl_name: "ec_posts",
							sql: "CREATE TABLE ec_posts (id TEXT)",
						},
					]);
				}
				if (statement === 'SELECT * FROM "ec_posts"')
					return rows([{ id: "post-1" }]);
				throw new Error(`Unexpected SQL: ${statement}`);
			},
		};
		const blockConcurrencyWhile = vi.fn(async (run: () => Promise<unknown>) => {
			events.push("block-enter");
			const result = await run();
			events.push("block-leave");
			return result;
		});
		const getCurrentBookmark = vi.fn(async () => {
			events.push("bookmark");
			return "bookmark-1";
		});
		const object = {
			ctx: {
				storage: { sql, getCurrentBookmark },
				blockConcurrencyWhile,
			},
		} as unknown as EmDashDB;
		const snapshot =
			await EmDashDB.prototype.captureRecoverySnapshot.call(object);
		expect(snapshot).toEqual({
			bookmark: "bookmark-1",
			databaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(events).toEqual([
			"block-enter",
			"digest",
			"bookmark",
			"block-leave",
		]);
		expect(blockConcurrencyWhile).toHaveBeenCalledOnce();
	});

	test("snapshot failure returns from concurrency block before throwing", async () => {
		const failure = new Error("database too large");
		let callbackRejected = false;
		const blockConcurrencyWhile = vi.fn(async (run: () => Promise<unknown>) => {
			try {
				return await run();
			} catch (error) {
				callbackRejected = true;
				throw error;
			}
		});
		const object = {
			ctx: {
				storage: {
					sql: {
						exec: () => {
							throw failure;
						},
					},
				},
				blockConcurrencyWhile,
			},
		} as unknown as EmDashDB;
		await expect(
			EmDashDB.prototype.captureRecoverySnapshot.call(object),
		).rejects.toBe(failure);
		expect(callbackRejected).toBe(false);
		expect(blockConcurrencyWhile).toHaveBeenCalledOnce();
	});

	test("deletes the whole tenant object only with internal authorization", async () => {
		const { siteId, slug } = await mediaAdminSite("paused");
		await mediaAdminDeprovisionReceipt(siteId, slug);
		const deleteTenantData = vi.fn().mockResolvedValue(undefined);
		const stub = {
			deleteTenantData,
		};
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			PLATFORM_DB: mediaAdminD1,
			DB_DO: { idFromName: (name: string) => name, get: () => stub },
		};
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/deprovision`,
		);
		const unauthorized = await databaseDeprovisionAdminResponse({
			env: env as never,
			request: new Request(url, { method: "DELETE" }),
			slug,
			url,
		});
		expect(unauthorized?.status).toBe(401);
		expect(deleteTenantData).not.toHaveBeenCalled();

		const authorized = await databaseDeprovisionAdminResponse({
			env: env as never,
			request: new Request(url, {
				method: "DELETE",
				headers: {
					"X-Tedix-CMS-Internal-Auth": "internal-secret",
					"X-Tedix-CMS-Site-Id": siteId,
				},
			}),
			slug,
			url,
		});
		expect(authorized?.status).toBe(200);
		expect(deleteTenantData).toHaveBeenCalledOnce();
		expect(await authorized?.json()).toMatchObject({ deletedStorage: true });
	});

	test("rejects database deletion without exact site and running receipt", async () => {
		const { siteId, slug } = await mediaAdminSite("paused");
		const deleteTenantData = vi.fn();
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/deprovision`,
		);
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			PLATFORM_DB: mediaAdminD1,
			DB_DO: {
				idFromName: (name: string) => name,
				get: () => ({ deleteTenantData }),
			},
		} as never;
		const deletion = (headerSiteId?: string) =>
			databaseDeprovisionAdminResponse({
				env,
				request: new Request(url, {
					method: "DELETE",
					headers: {
						"X-Tedix-CMS-Internal-Auth": "internal-secret",
						...(headerSiteId ? { "X-Tedix-CMS-Site-Id": headerSiteId } : {}),
					},
				}),
				slug,
				url,
			});
		expect((await deletion())?.status).toBe(400);
		expect((await deletion(crypto.randomUUID()))?.status).toBe(409);
		expect((await deletion(siteId))?.status).toBe(409);
		expect(deleteTenantData).not.toHaveBeenCalled();
	});

	test("fails closed when deprovision authority is queued or D1 is unavailable", async () => {
		const { siteId, slug } = await mediaAdminSite("paused");
		await mediaAdminD1
			.prepare(
				"INSERT INTO cms_deprovision_operations (id, organization_id, slug, status) VALUES (?, ?, ?, 'queued')",
			)
			.bind(siteId, "test-org", slug)
			.run();
		const deleteTenantData = vi.fn();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const brokenD1 = {
			prepare: () => {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const databaseUrl = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/deprovision`,
		);
		const request = (url: URL) =>
			new Request(url, {
				method: "DELETE",
				headers: {
					"X-Tedix-CMS-Internal-Auth": "internal-secret",
					"X-Tedix-CMS-Site-Id": siteId,
				},
			});
		const databaseArgs = (platformDb: D1Database) => ({
			env: {
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				PLATFORM_DB: platformDb,
				DB_DO: {
					idFromName: (name: string) => name,
					get: () => ({ deleteTenantData }),
				},
			} as never,
			request: request(databaseUrl),
			slug,
			url: databaseUrl,
		});
		expect(
			(await databaseDeprovisionAdminResponse(databaseArgs(mediaAdminD1)))
				?.status,
		).toBe(409);
		expect(
			(await databaseDeprovisionAdminResponse(databaseArgs(brokenD1)))?.status,
		).toBe(503);
		const mediaUrl = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
		);
		const media = await mediaBucketAdminResponse({
			accountId: "account",
			env: {
				CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
				PLATFORM_DB: brokenD1,
			} as never,
			r2Token: "r2-token",
			request: request(mediaUrl),
			slug,
			url: mediaUrl,
		});
		expect(media?.status).toBe(503);
		expect(deleteTenantData).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("deletes primary storage without table-level foreign key failures", async () => {
		const deleteAll = vi.fn().mockResolvedValue(undefined);
		await EmDashDB.prototype.deleteTenantData.call({
			ctx: { storage: { deleteAll } },
		} as unknown as EmDashDB);
		expect(deleteAll).toHaveBeenCalledOnce();
	});

	test("routes replica deletion to the primary", async () => {
		const deleteAll = vi.fn();
		const deleteTenantData = vi.fn().mockResolvedValue(undefined);
		await EmDashDB.prototype.deleteTenantData.call({
			ctx: { storage: { deleteAll, primary: { deleteTenantData } } },
		} as unknown as EmDashDB);
		expect(deleteTenantData).toHaveBeenCalledOnce();
		expect(deleteAll).not.toHaveBeenCalled();
	});
});

describe("CMS origin route policy", () => {
	test("keeps signed previews on the tenant origin while ordinary pages redirect", () => {
		const env = { ENVIRONMENT: "production" } as unknown as Parameters<
			typeof shouldRedirectCmsOriginRequest
		>[2];
		const org = { publicSiteUrl: "https://tedix.dev" } as Parameters<
			typeof shouldRedirectCmsOriginRequest
		>[3];
		const root = new URL("https://tedix-landing.cms.tedix.dev/");
		const preview = new URL(
			"https://tedix-landing.cms.tedix.dev/?_preview=signed.token",
		);

		expect(
			shouldRedirectCmsOriginRequest(new Request(root), root, env, org),
		).toBe(true);
		expect(
			shouldRedirectCmsOriginRequest(new Request(preview), preview, env, org),
		).toBe(false);
		expect(
			shouldRedirectCmsOriginRequest(
				new Request(root, { method: "HEAD" }),
				root,
				env,
				org,
			),
		).toBe(true);
		expect(
			shouldRedirectCmsOriginRequest(
				new Request("https://tedix.dev/"),
				new URL("https://tedix.dev/"),
				env,
				org,
			),
		).toBe(false);
	});

	test("does not preserve the retired blog route", () => {
		expect(isOriginRedirectablePath("/blog")).toBe(false);
		expect(isOriginRedirectablePath("/blog/example")).toBe(false);
	});

	test("keeps current CMS routes canonical on the public host", () => {
		expect(isOriginRedirectablePath("/")).toBe(true);
		expect(isOriginRedirectablePath("/posts/example")).toBe(true);
		expect(isOriginRedirectablePath("/sitemap.xml")).toBe(true);
	});
});

describe("missing tenant routes", () => {
	const redirect = (location: string, status = 302) =>
		new Response(null, { status, headers: { Location: location } });
	const get = new Request("https://tedix.dev/missing");

	test("serves the tenant /404 redirect in place", () => {
		expect(isSoftNotFound(redirect("/404"), get)).toBe(true);
		expect(isSoftNotFound(redirect("https://tedix.dev/404"), get)).toBe(true);
	});

	test("leaves real redirects and non-GET requests alone", () => {
		expect(isSoftNotFound(redirect("/posts/"), get)).toBe(false);
		expect(isSoftNotFound(redirect("https://other.example/404"), get)).toBe(
			false,
		);
		expect(isSoftNotFound(new Response("ok"), get)).toBe(false);
		expect(
			isSoftNotFound(
				redirect("/404"),
				new Request("https://tedix.dev/missing", { method: "POST" }),
			),
		).toBe(false);
	});
});

describe("Durable Object database runtime", () => {
	test("classifies bundle adapters from the compiled emdash config", () => {
		// Shape Astro emits for `virtual:emdash/config` in live tenant bundles.
		const config = (entrypoint: string, binding: string) =>
			`var config_default = {\n\t"database": {\n\t\t"entrypoint": "${entrypoint}",\n\t\t"config": {\n\t\t\t"binding": "${binding}",\n\t\t\t"name": "tenant"\n\t\t}\n\t}\n};`;
		expect(
			detectBundleDatabaseAdapter({
				"chunks/config.mjs": {
					js: config(
						"/workspace/src/lib/worker-loader-do-sql-runtime.ts",
						"DB_DO",
					),
				},
			}),
		).toEqual({
			adapter: "durableObjects",
			evidence: [
				'binding "DB_DO"',
				'entrypoint "/workspace/src/lib/worker-loader-do-sql-runtime.ts"',
			],
		});
		expect(
			detectBundleDatabaseAdapter({
				"chunks/config.mjs": {
					js: config("@emdash-cms/cloudflare/db/d1", "DB"),
				},
			}),
		).toMatchObject({ adapter: "d1" });
		expect(
			detectBundleDatabaseAdapter({ "entry.mjs": { js: "export {};" } }),
		).toMatchObject({ adapter: "unknown" });
	});

	test("admin diagnostic reports the active bundle adapter", async () => {
		const bundle = {
			etag: "etag",
			mainModule: "entry.mjs",
			modulesJson: ["entry.mjs"],
			r2Prefix: "tenant/v1/",
			version: 1,
		};
		const dependencies = {
			async lookupActiveBundle() {
				return bundle as never;
			},
			async loadBundleModules() {
				return {
					mainModule: "entry.mjs",
					modules: {
						"entry.mjs": { js: '{ "database": { "entrypoint": "do-sql" } }' },
					},
				};
			},
		} satisfies DatabaseRuntimeAdminDependencies;
		const url = "https://tenant.cms.tedix.dev/_tedix/internal/database-runtime";
		const request = (method: string) =>
			new Request(url, {
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
				method,
			});
		const env = { CMS_INTERNAL_AUTH_TOKEN: "internal-secret" } as never;

		const response = await databaseRuntimeAdminResponse(
			{ env, request: request("GET"), slug: "tenant", url: new URL(url) },
			dependencies,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({
			activeBundle: { databaseAdapter: "durableObjects" },
			databaseRuntime: { currentBackend: "durableObjects" },
		});

		const post = await databaseRuntimeAdminResponse(
			{ env, request: request("POST"), slug: "tenant", url: new URL(url) },
			dependencies,
		);
		expect(post?.status).toBe(405);
	});

	test("TenantEmDashDB exposes direct RPC methods", async () => {
		const calls: string[] = [];
		const stub = {
			async batchQuery() {
				calls.push("batchQuery");
				return [];
			},
			async query() {
				calls.push("query");
				return { rows: [] };
			},
		};
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: { props: { name: "tenant", siteId: "site-1", slug: "tenant" } },
			env: {
				PLATFORM_DB: acceptingPermitD1(),
				DB_DO: {
					get: () => stub,
					idFromName: (name: string) => name,
				},
			},
		}) as TenantEmDashDB;

		await TenantEmDashDB.prototype.query.call(entrypoint, "SELECT 1");
		await TenantEmDashDB.prototype.batchQuery.call(entrypoint, []);
		expect(calls).toEqual(["query", "batchQuery"]);
	});

	test("TenantEmDashDB logs only a fixed table group for incident traces", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: { props: { name: "tenant", siteId: "site-1", slug: "tenant" } },
			env: {
				PLATFORM_DB: acceptingPermitD1(),
				DB_DO: {
					get: () => ({ query: async () => ({ rows: [] }) }),
					idFromName: (name: string) => name,
				},
			},
		}) as TenantEmDashDB;
		const sql = "SELECT value FROM \"options\" WHERE name = 'private-value'";

		await TenantEmDashDB.prototype.query.call(entrypoint, sql, [
			"private-param",
		]);
		expect(info).toHaveBeenCalledWith(
			"[cms-runtime] tenant database query entered",
			{ tenant: "tenant", selectOnly: true, tableGroup: "options" },
		);
		const logged = JSON.stringify(info.mock.calls);
		expect(logged).not.toContain("private-value");
		expect(logged).not.toContain("private-param");
	});

	test("TenantEmDashDB retries a stalled SELECT RPC once", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const query = vi
			.fn()
			.mockImplementationOnce(() => new Promise(() => undefined))
			.mockResolvedValue({ rows: [{ value: 1 }] });
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: { props: { name: "tenant", siteId: "site-1", slug: "tenant" } },
			env: {
				PLATFORM_DB: acceptingPermitD1(),
				DB_DO: { get: () => ({ query }), idFromName: (name: string) => name },
			},
		}) as TenantEmDashDB;

		const result = TenantEmDashDB.prototype.query.call(entrypoint, "SELECT 1");
		await vi.advanceTimersByTimeAsync(4_000);
		await expect(result).resolves.toEqual({ rows: [{ value: 1 }] });
		expect(query).toHaveBeenCalledTimes(2);
	});

	test("TenantEmDashDB bounds a stalled SELECT batch and rejects a second stall", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const batchQuery = vi
			.fn()
			.mockImplementation(() => new Promise(() => undefined));
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: { props: { name: "tenant", siteId: "site-1", slug: "tenant" } },
			env: {
				PLATFORM_DB: acceptingPermitD1(),
				DB_DO: {
					get: () => ({ batchQuery }),
					idFromName: (name: string) => name,
				},
			},
		}) as TenantEmDashDB;

		const result = TenantEmDashDB.prototype.batchQuery.call(entrypoint, [
			{ sql: "SELECT 1" },
		]);
		const assertion = expect(result).rejects.toThrow(
			"Tenant database read RPC timed out",
		);
		await vi.advanceTimersByTimeAsync(8_000);
		await assertion;
		expect(batchQuery).toHaveBeenCalledTimes(2);
	});

	test("TenantEmDashDB does not retry writes or mixed batches", async () => {
		const query = vi.fn().mockRejectedValue(new Error("write failed"));
		const batchQuery = vi.fn().mockRejectedValue(new Error("batch failed"));
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: { props: { name: "tenant", siteId: "site-1", slug: "tenant" } },
			env: {
				PLATFORM_DB: acceptingPermitD1(),
				DB_DO: {
					get: () => ({ query, batchQuery }),
					idFromName: (name: string) => name,
				},
			},
		}) as TenantEmDashDB;

		await expect(
			TenantEmDashDB.prototype.query.call(
				entrypoint,
				"INSERT INTO entries VALUES (1)",
			),
		).rejects.toThrow("write failed");
		await expect(
			TenantEmDashDB.prototype.batchQuery.call(entrypoint, [
				{ sql: "SELECT 1" },
				{ sql: "UPDATE entries SET value = 2" },
			]),
		).rejects.toThrow("batch failed");
		expect(query).toHaveBeenCalledTimes(1);
		expect(batchQuery).toHaveBeenCalledTimes(1);
	});
});

describe("sitemap canonical paths", () => {
	test("preserves authoritative native canonicals with mixed slash conventions", () => {
		const native =
			'<urlset><url><loc>https://personal.example/writing/</loc><xhtml:link href="https://personal.example/blog/skills"/></url></urlset>';
		expect(canonicalizeSitemapUrls(native, false, true)).toBe(native);
		expect(canonicalizeSitemapUrls(native, true, true)).toBe(native);
	});
	const xml =
		'<urlset><url><loc>https://tedix.dev/de/</loc><xhtml:link href="https://tedix.dev/es"/><image:loc>https://tedix.dev/logo.png</image:loc></url><url><loc>https://tedix.dev/</loc></url></urlset>';
	test("marketing matches slashless redirects and leaves root and assets intact", () => {
		expect(canonicalizeSitemapUrls(xml, false)).toBe(
			xml.replace("https://tedix.dev/de/", "https://tedix.dev/de"),
		);
	});
	test("blogs retain their established trailing slash convention", () => {
		expect(canonicalizeSitemapUrls(xml)).toBe(
			xml.replace(
				'href="https://tedix.dev/es"',
				'href="https://tedix.dev/es/"',
			),
		);
	});
	test("only the Tedix landing tenant restores archived trailing-slash canonicals", () => {
		const domains = { MARKETING_DOMAINS: "tedix.dev,www.tedix.dev" };
		const workshop = {
			slug: "workshop",
			templateSlug: "marketing",
			publicSiteUrl: "https://workshop.cms.tedix.dev",
		};
		const blog = {
			slug: "blog",
			templateSlug: "tedix",
			publicSiteUrl: "https://blog.example.com",
		};
		const landing = {
			slug: "tedix-landing",
			templateSlug: "marketing",
			publicSiteUrl: "https://tedix.dev",
		};
		expect(sitemapUsesTrailingSlash(workshop, domains)).toBe(false);
		expect(sitemapUsesTrailingSlash(blog, domains)).toBe(true);
		expect(sitemapUsesTrailingSlash(landing, domains)).toBe(true);
		expect(
			sitemapUsesTrailingSlash({ ...landing, slug: "other" }, domains),
		).toBe(false);
		expect(
			canonicalizeSitemapUrls(xml, sitemapUsesTrailingSlash(landing, domains)),
		).toContain('href="https://tedix.dev/es/"');
		expect(
			sitemapUsesTrailingSlash(
				{
					slug: "other",
					templateSlug: "tedix",
					publicSiteUrl: "https://tedix.dev",
				},
				domains,
			),
		).toBe(false);
		expect(
			canonicalizeSitemapUrls(
				"<urlset><url><loc>https://workshop.cms.tedix.dev/features</loc></url></urlset>",
				sitemapUsesTrailingSlash(workshop, domains),
			),
		).toContain("<loc>https://workshop.cms.tedix.dev/features</loc>");
	});
});
