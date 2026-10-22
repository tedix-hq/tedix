import { env } from "cloudflare:workers";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	enterCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import type { EmDashDB } from "./emdash-db";

const mocks = vi.hoisted(() => ({ site: vi.fn(), contact: vi.fn() }));
vi.mock("@tedix/db/queries/cms-sites", async (original) => ({
	...(await original<object>()),
	getCmsSiteBySlug: mocks.site,
}));
vi.mock("./marketing", async (original) => ({
	...(await original<object>()),
	marketingResponse: mocks.contact,
}));
vi.mock("@tedix/db/queries/cms-restore-fences", async (original) => {
	const queries =
		await original<typeof import("@tedix/db/queries/cms-restore-fences")>();
	return {
		...queries,
		enterCmsRestorePermit: vi.fn(queries.enterCmsRestorePermit),
	};
});
import worker, { loadBundleModules } from "./index";

const platformD1 = (env as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;
const db = createDbQueryClient(platformD1);
const namespace = (
	env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
).DB_DO;
let lastCall = 0;
afterEach(async () => {
	const remaining = lastCall + 10_100 - Date.now();
	if (remaining > 0)
		await new Promise((resolve) => setTimeout(resolve, remaining));
	lastCall = 0;
	vi.restoreAllMocks();
}, 20_000);
beforeEach(() => {
	vi.mocked(enterCmsRestorePermit).mockClear();
	mocks.contact
		.mockReset()
		.mockImplementation(async () => new Response("accepted", { status: 202 }));
});

beforeAll(async () => {
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_sites (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, config TEXT)",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_fences (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL, capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_deprovision_operations (id TEXT PRIMARY KEY)",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_permits (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'legacy', entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_capture_cron_pauses (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL, expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER)",
		)
		.run();
});

async function fixture(beforeBorrow?: () => Promise<void>) {
	const siteId = crypto.randomUUID();
	const identity = { siteId, slug: `tenant-${siteId}`, restoreEpoch: 0 };
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(siteId, identity.slug)
		.run();
	mocks.site.mockResolvedValue({
		id: siteId,
		slug: identity.slug,
		restoreEpoch: 0,
	});
	const coordinator = namespace.get(namespace.idFromName(identity.slug));
	const borrow = vi.fn(
		async (...args: Parameters<EmDashDB["runWithRestorePermit"]>) => {
			lastCall = Date.now();
			await beforeBorrow?.();
			return coordinator.runWithRestorePermit(...args);
		},
	);
	const put = vi.fn().mockResolvedValue(undefined);
	const runtimeEnv = {
		PLATFORM_DB: platformD1,
		DB_DO: {
			idFromName: (name: string) => name,
			get: () => ({ runWithRestorePermit: borrow }),
		},
		MARKETING_DOMAINS: "marketing.example",
		MARKETING_SITE_SLUG: identity.slug,
		TENANT_BUNDLES: {
			get: async (key: string) =>
				key.endsWith("__tedix_packed_bundle.json")
					? new Response(
							JSON.stringify({
								mainModule: "entry.mjs",
								modules: { "entry.mjs": { js: "export default 1" } },
							}),
						)
					: null,
			put,
		},
	};
	const tasks: Promise<unknown>[] = [];
	const request = async () => {
		const response = await worker.fetch(
			new Request("https://marketing.example/api/contact", { method: "POST" }),
			runtimeEnv as never,
			{
				waitUntil: (task: Promise<unknown>) => tasks.push(task),
			} as unknown as ExecutionContext,
		);
		await response.text();
		await Promise.all(tasks);
		return response;
	};
	const rows = async () =>
		(
			await platformD1
				.prepare(
					"SELECT id FROM cms_restore_permits WHERE site_id = ? AND kind = 'nested'",
				)
				.bind(siteId)
				.all()
		).results;
	return { identity, runtimeEnv, put, borrow, request, rows };
}

async function close(
	identity: { siteId: string; slug: string },
	reason: "restore" | "pause",
) {
	if (reason === "restore")
		expect(
			await closeCmsRestoreFence(db, {
				...identity,
				generation: "generation",
				captureId: "capture",
			}),
		).toBe(true);
	else
		await platformD1
			.prepare("UPDATE cms_sites SET status = 'paused' WHERE id = ?")
			.bind(identity.siteId)
			.run();
}

describe("remaining CMS shared permit paths", () => {
	test("bundle writes run once per load and keep one shared reservation", async () => {
		const { identity, runtimeEnv, put, borrow, rows } = await fixture();
		let reservation: unknown;
		for (const prefix of ["tenant/v1/", "tenant/v2/"]) {
			put.mockClear();
			await loadBundleModules(runtimeEnv as never, prefix, {
				restoreIdentity: identity,
			});
			expect(put).toHaveBeenCalledOnce();
			expect(await rows()).toHaveLength(1);
			if (reservation) expect(await rows()).toEqual(reservation);
			reservation = await rows();
		}
		expect(borrow).toHaveBeenCalledTimes(2);
		expect(enterCmsRestorePermit).toHaveBeenCalledOnce();
	});

	test.each(["restore", "pause"] as const)(
		"%s skips the bundle write but still returns the loaded bundle",
		async (reason) => {
			const { identity, runtimeEnv, put } = await fixture();
			await close(identity, reason);
			const loaded = await loadBundleModules(
				runtimeEnv as never,
				"tenant/v1/",
				{ restoreIdentity: identity },
			);
			expect(loaded.mainModule).toBe("entry.mjs");
			expect(put).not.toHaveBeenCalled();
			expect(enterCmsRestorePermit).toHaveBeenCalledOnce();
		},
	);

	test("contact POST runs once per request with no exact nested permit", async () => {
		const { request, borrow, rows } = await fixture();
		expect((await request()).status).toBe(202);
		const reservation = await rows();
		expect(reservation).toHaveLength(1);
		mocks.contact.mockClear();
		expect((await request()).status).toBe(202);
		expect(mocks.contact).toHaveBeenCalledOnce();
		expect(borrow).toHaveBeenCalledTimes(2);
		expect(await rows()).toEqual(reservation);
		expect(enterCmsRestorePermit).toHaveBeenCalled();
		expect(
			vi
				.mocked(enterCmsRestorePermit)
				.mock.calls.filter(([, permit]) => permit.kind === "nested"),
		).toHaveLength(1);
	});

	test.each(["restore", "pause"] as const)(
		"%s between outer admission and contact dispatch returns the same 503",
		async (reason) => {
			let identity!: { siteId: string; slug: string };
			const fixtureResult = await fixture(() => close(identity, reason));
			identity = fixtureResult.identity;
			const response = await fixtureResult.request();
			expect(response.status).toBe(503);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(mocks.contact).not.toHaveBeenCalled();
			expect(fixtureResult.borrow).toHaveBeenCalledOnce();
			expect(await fixtureResult.rows()).toHaveLength(0);
		},
	);
});
