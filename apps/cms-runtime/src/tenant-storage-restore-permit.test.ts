import { env } from "cloudflare:workers";
import {
	beforeAll,
	afterEach,
	describe,
	expect,
	test,
	vi,
} from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreEpoch,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";

import { TenantEmDashDB, TenantR2, TenantSession } from "./index";
import { CmsRestoreFenceUnavailableError } from "./tenant-restore-fence";

const platformD1 = (env as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;
const db = createDbQueryClient(platformD1);

beforeAll(async () => {
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_sites (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0)",
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

afterEach(() => {
	vi.unstubAllGlobals();
});

async function site() {
	const id = crypto.randomUUID();
	const identity = { siteId: id, slug: `tenant-${id}`, restoreEpoch: 0 };
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(id, identity.slug)
		.run();
	return identity;
}

function tenantDb(
	identity: { siteId: string; slug: string; restoreEpoch: number },
	stub: Record<string, unknown>,
): TenantEmDashDB {
	return Object.assign(Object.create(TenantEmDashDB.prototype), {
		ctx: { props: { name: identity.slug, ...identity } },
		env: {
			PLATFORM_DB: platformD1,
			DB_DO: { idFromName: (name: string) => name, get: () => stub },
		},
	}) as TenantEmDashDB;
}

function tenantR2(identity: {
	siteId: string;
	slug: string;
	restoreEpoch: number;
}): TenantR2 {
	return Object.assign(Object.create(TenantR2.prototype), {
		ctx: {
			props: {
				...identity,
				accountId: "account",
				bucketName: "media",
				token: "test-token",
			},
		},
		env: { PLATFORM_DB: platformD1 },
	}) as TenantR2;
}

function tenantSession(
	identity: { siteId: string; slug: string; restoreEpoch: number },
	storage: Record<string, unknown>,
): TenantSession {
	return Object.assign(Object.create(TenantSession.prototype), {
		ctx: { props: identity },
		env: { PLATFORM_DB: platformD1, SESSION: storage },
	}) as TenantSession;
}

describe("nested tenant storage restore permits", () => {
	test("a close drains an in-flight DB RPC and denies the next one", async () => {
		const identity = await site();
		let finish!: (value: { rows: [] }) => void;
		const query = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<{ rows: [] }>((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValue({ rows: [] });
		const entrypoint = tenantDb(identity, { query });
		const pending = entrypoint.query("UPDATE content SET title = 'new'");
		await vi.waitFor(async () => {
			expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		});
		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		await expect(
			entrypoint.query("DELETE FROM content"),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		expect(query).toHaveBeenCalledTimes(1);
		finish({ rows: [] });
		await expect(pending).resolves.toEqual({ rows: [] });
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		await expect(entrypoint.query("SELECT 1")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		const currentEpoch = await getCmsRestoreEpoch(db, identity);
		expect(currentEpoch).toBe(1);
		await expect(
			tenantDb({ ...identity, restoreEpoch: currentEpoch! }, { query }).query(
				"SELECT 1",
			),
		).resolves.toEqual({ rows: [] });
	});

	test("closed site denies every DB, R2, and session mutation before dispatch", async () => {
		const identity = await site();
		const query = vi.fn().mockResolvedValue({ rows: [] });
		const batchQuery = vi.fn().mockResolvedValue([]);
		const executeCollectionDeletionGuard = vi.fn().mockResolvedValue({
			outcome: "fenced",
		});
		const database = tenantDb(identity, {
			query,
			batchQuery,
			executeCollectionDeletionGuard,
		});
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const media = tenantR2(identity);
		const put = vi.fn();
		const remove = vi.fn();
		const session = tenantSession(identity, { put, delete: remove });
		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		await expect(database.query("SELECT 1")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(
			database.batchQuery([{ sql: "SELECT 1" }]),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		await expect(
			database.executeCollectionDeletionGuard({
				action: "fence",
				collectionId: "id",
				collectionSlug: "content",
				leaseToken: "lease",
				forceDelete: false,
			}),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		await expect(media.put("media/key", "value")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(media.delete("media/key")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(session.put("key", "value")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(session.delete("key")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(query).not.toHaveBeenCalled();
		expect(batchQuery).not.toHaveBeenCalled();
		expect(executeCollectionDeletionGuard).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
	});

	test("releases after a failed RPC and leaves another site usable", async () => {
		const closedSite = await site();
		const openSite = await site();
		const fence = { ...closedSite, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		const query = vi.fn().mockRejectedValue(new Error("DO failed"));
		await expect(
			tenantDb(openSite, { query }).query("INSERT INTO content VALUES (1)"),
		).rejects.toThrow("DO failed");
		expect((await getCmsRestoreFenceState(db, openSite)).inFlight).toBe(0);
		const put = vi.fn();
		await tenantSession(openSite, { put }).put("key", "value");
		expect(put).toHaveBeenCalledWith(
			`${openSite.slug}:key`,
			"value",
			undefined,
		);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
	});

	test("a D1 admission failure cannot dispatch a storage write", async () => {
		const identity = await site();
		const brokenD1 = {
			prepare: () => {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const put = vi.fn();
		const session = Object.assign(Object.create(TenantSession.prototype), {
			ctx: { props: identity },
			env: { PLATFORM_DB: brokenD1, SESSION: { put } },
		}) as TenantSession;
		await expect(session.put("key", "value")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(put).not.toHaveBeenCalled();
	});

	test("holds a streamed R2 PUT through its post-write metadata read", async () => {
		const identity = await site();
		let finishPut!: () => void;
		let finishHead!: () => void;
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			if (init.method === "PUT") {
				await new Response(init.body).arrayBuffer();
				await new Promise<void>((resolve) => {
					finishPut = resolve;
				});
				return new Response(null, { status: 200 });
			}
			await new Promise<void>((resolve) => {
				finishHead = resolve;
			});
			return Response.json({
				result: [{ key: "media/key", size: 3, etag: "hash" }],
			});
		});
		vi.stubGlobal("fetch", fetch);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const pending = tenantR2(identity).put("media/key", stream);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		finishPut();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		finishHead();
		expect(await pending).toEqual({ httpEtag: '"hash"', size: 3 });
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
	});
});
