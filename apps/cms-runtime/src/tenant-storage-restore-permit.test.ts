import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
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
	reconcileCmsRestoreOuterPermits,
} from "@tedix/db/queries/cms-restore-fences";

import { EmDashDB, TenantEmDashDB, TenantR2, TenantSession } from "./index";
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

let lastCoordinatorCallAt = 0;
afterEach(async () => {
	const remaining = lastCoordinatorCallAt + 10_100 - Date.now();
	if (remaining > 0)
		await new Promise((resolve) => setTimeout(resolve, remaining));
	lastCoordinatorCallAt = 0;
	vi.unstubAllGlobals();
}, 20_000);

async function site() {
	const id = crypto.randomUUID();
	const identity = { siteId: id, slug: `tenant-${id}`, restoreEpoch: 0 };
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(id, identity.slug)
		.run();
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	await namespace
		.get(namespace.idFromName(identity.slug))
		.query("CREATE TABLE content (id INTEGER PRIMARY KEY, title TEXT)");
	return identity;
}

function tenantDb(
	identity: { siteId: string; slug: string; restoreEpoch: number },
	stub: Record<string, unknown>,
): TenantEmDashDB {
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	const coordinator = namespace.get(namespace.idFromName(identity.slug));
	const combined = {
		...stub,
		queryWithRestorePermit: (
			...args: Parameters<EmDashDB["queryWithRestorePermit"]>
		) => {
			lastCoordinatorCallAt = Date.now();
			return coordinator.queryWithRestorePermit(...args);
		},
		batchQueryWithRestorePermit: (
			...args: Parameters<EmDashDB["batchQueryWithRestorePermit"]>
		) => {
			lastCoordinatorCallAt = Date.now();
			return coordinator.batchQueryWithRestorePermit(...args);
		},
	};
	return Object.assign(Object.create(TenantEmDashDB.prototype), {
		ctx: {
			props: { name: identity.slug, ...identity },
		},
		env: {
			PLATFORM_DB: platformD1,
			DB_DO: { idFromName: (name: string) => name, get: () => combined },
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
	test("shares SQL reads as nested claims that restore reconciliation cannot reclaim", async () => {
		const identity = await site();
		const query = vi.fn().mockResolvedValue({ rows: [] });
		const entrypoint = tenantDb(identity, { query });
		for (let i = 0; i < 100; i++)
			await tenantDb(identity, { query }).query("SELECT 1");
		const permits = await platformD1
			.prepare(
				"SELECT kind, COUNT(*) AS n FROM cms_restore_permits WHERE site_id = ? GROUP BY kind",
			)
			.bind(identity.siteId)
			.all();
		expect(permits.results).toEqual([{ kind: "nested", n: 1 }]);
		const fence = {
			...identity,
			generation: "shared-read",
			captureId: "read-capture",
		};
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, fence)).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		await expect(entrypoint.query("SELECT 1")).rejects.toThrow(
			"fence unavailable",
		);
		expect(query).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 10_100));
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
	}, 20_000);

	test("shares SQL mutation admission without sharing the mutations", async () => {
		const identity = await site();
		const entrypoint = tenantDb(identity, {});
		for (let i = 0; i < 100; i++)
			await entrypoint.query("INSERT INTO content (id, title) VALUES (?, ?)", [
				i,
				"original",
			]);
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		await expect(
			entrypoint.query("SELECT COUNT(*) AS n FROM content"),
		).resolves.toMatchObject({ rows: [{ n: 100 }] });
		const fence = {
			...identity,
			generation: "writes",
			captureId: "writes-capture",
		};
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, fence)).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		await expect(
			entrypoint.query("UPDATE content SET title = 'closed'"),
		).rejects.toThrow("fence unavailable");
		const namespace = (
			env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
		).DB_DO;
		await expect(
			namespace
				.get(namespace.idFromName(identity.slug))
				.query("SELECT COUNT(*) AS n FROM content WHERE title = 'original'"),
		).resolves.toMatchObject({ rows: [{ n: 100 }] });
	});

	test("coordinator rejects a mismatched site before admission", async () => {
		const identity = await site();
		const namespace = (
			env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
		).DB_DO;
		const coordinator = namespace.get(namespace.idFromName(identity.slug));
		const error = await runInDurableObject(
			coordinator,
			async (instance: EmDashDB) => {
				try {
					await instance.queryWithRestorePermit(
						{ ...identity, slug: "another-site" },
						"INSERT INTO content (id) VALUES (1)",
					);
					return null;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		);
		expect(error).toBe("CMS restore fence unavailable");
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
		await expect(
			coordinator.query("SELECT COUNT(*) AS n FROM content"),
		).resolves.toMatchObject({ rows: [{ n: 0 }] });
	});

	test("shares admission for read-only and mixed SQL batches", async () => {
		const identity = await site();
		const batchQuery = vi.fn().mockResolvedValue([]);
		const entrypoint = tenantDb(identity, { batchQuery });
		await entrypoint.batchQuery([{ sql: "SELECT 1" }]);
		await entrypoint.batchQuery([{ sql: "SELECT 2" }]);
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		await entrypoint.batchQuery([
			{ sql: "SELECT 1" },
			{ sql: "INSERT INTO content (id, title) VALUES (1, 'batch')" },
		]);
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		await expect(
			entrypoint.query("SELECT title FROM content"),
		).resolves.toMatchObject({ rows: [{ title: "batch" }] });
		expect(batchQuery).not.toHaveBeenCalled();
	});

	test("a close drains an in-flight guarded DB operation and denies the next one", async () => {
		const identity = await site();
		let finish!: (value: { outcome: "fenced" }) => void;
		const executeCollectionDeletionGuard = vi.fn().mockImplementationOnce(
			() =>
				new Promise<{ outcome: "fenced" }>((resolve) => {
					finish = resolve;
				}),
		);
		const entrypoint = tenantDb(identity, { executeCollectionDeletionGuard });
		const input = {
			action: "fence" as const,
			collectionId: "id",
			collectionSlug: "content",
			leaseToken: "lease",
			forceDelete: false,
		};
		const pending = entrypoint.executeCollectionDeletionGuard(input);
		await vi.waitFor(async () => {
			expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		});
		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		await expect(
			entrypoint.executeCollectionDeletionGuard(input),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		expect(executeCollectionDeletionGuard).toHaveBeenCalledTimes(1);
		finish({ outcome: "fenced" });
		await expect(pending).resolves.toEqual({ outcome: "fenced" });
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		await expect(entrypoint.query("SELECT 1")).rejects.toThrow(
			"fence unavailable",
		);
		const currentEpoch = await getCmsRestoreEpoch(db, identity);
		expect(currentEpoch).toBe(1);
		await expect(
			tenantDb({ ...identity, restoreEpoch: currentEpoch! }, {}).query(
				"SELECT 1",
			),
		).resolves.toMatchObject({ rows: [{ "1": 1 }] });
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
		await expect(database.query("SELECT 1")).rejects.toThrow(
			"fence unavailable",
		);
		await expect(database.batchQuery([{ sql: "SELECT 1" }])).rejects.toThrow(
			"fence unavailable",
		);
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

	test("releases a failed SQL reservation after expiry and leaves another site usable", async () => {
		const closedSite = await site();
		const openSite = await site();
		const fence = { ...closedSite, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		await expect(
			tenantDb(openSite, {}).query("INSERT INTO missing_table VALUES (1)"),
		).rejects.toThrow("no such table");
		expect((await getCmsRestoreFenceState(db, openSite)).inFlight).toBe(1);
		const put = vi.fn();
		await tenantSession(openSite, { put }).put("key", "value");
		expect(put).toHaveBeenCalledWith(
			`${openSite.slug}:key`,
			"value",
			undefined,
		);
		await new Promise((resolve) => setTimeout(resolve, 10_100));
		expect((await getCmsRestoreFenceState(db, openSite)).inFlight).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
	}, 20_000);

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
