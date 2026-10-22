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
	countCmsRestorePermitsForSite,
	getCmsRestoreEpoch,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
	reconcileCmsRestoreOuterPermits,
} from "@tedix/db/queries/cms-restore-fences";

import { EmDashDB } from "./emdash-db";
import { TenantEmDashDB, TenantR2, TenantSession } from "./index";
import {
	CmsRestoreFenceUnavailableError,
	withCmsRestoreResponsePermit,
} from "./tenant-restore-fence";
import { PublicRestorePermits } from "./public-restore-permits";

const platformD1 = (env as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;
const db = createDbQueryClient(platformD1);

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
		runWithRestorePermit: (
			...args: Parameters<EmDashDB["runWithRestorePermit"]>
		) => {
			lastCoordinatorCallAt = Date.now();
			return coordinator.runWithRestorePermit(...args);
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

/** The real database objects, recording use so each test drains its reservation. */
function coordinators(): DurableObjectNamespace {
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	return {
		idFromName: (name: string) => namespace.idFromName(name),
		get: (id: DurableObjectId) => ({
			runWithRestorePermit: (
				...args: Parameters<EmDashDB["runWithRestorePermit"]>
			) => {
				lastCoordinatorCallAt = Date.now();
				return namespace.get(id).runWithRestorePermit(...args);
			},
		}),
	} as unknown as DurableObjectNamespace;
}

async function permitIds(siteId: string): Promise<string[]> {
	const rows = await platformD1
		.prepare("SELECT id FROM cms_restore_permits WHERE site_id = ?")
		.bind(siteId)
		.all<{ id: string }>();
	return rows.results.map((row) => row.id);
}

const reservationExpiry = () =>
	new Promise((resolve) => setTimeout(resolve, 10_100));

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
		env: { DB_DO: coordinators() },
	}) as TenantR2;
}

function tenantSession(
	identity: { siteId: string; slug: string; restoreEpoch: number },
	storage: Record<string, unknown>,
): TenantSession {
	return Object.assign(Object.create(TenantSession.prototype), {
		ctx: { props: identity },
		env: { DB_DO: coordinators(), SESSION: storage },
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

	test("concurrent SQL mutations share one coordinator reservation", async () => {
		const identity = await site();
		await Promise.all(
			Array.from({ length: 100 }, (_, i) =>
				tenantDb(identity, {}).query(
					"INSERT INTO content (id, title) VALUES (?, ?)",
					[i, "burst"],
				),
			),
		);
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1);
		await expect(
			tenantDb(identity, {}).query("SELECT COUNT(*) AS n FROM content"),
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
		await reservationExpiry();
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
	}, 20_000);

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

	test("a coordinator failure cannot dispatch a storage write", async () => {
		const identity = await site();
		const brokenCoordinator = {
			idFromName: (name: string) => name,
			get: () => ({
				runWithRestorePermit: async () => {
					throw new Error("D1 unavailable");
				},
			}),
		};
		const put = vi.fn();
		const session = Object.assign(Object.create(TenantSession.prototype), {
			ctx: { props: identity },
			env: { DB_DO: brokenCoordinator, SESSION: { put } },
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
		await reservationExpiry();
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
	}, 20_000);

	test("100 storage writes and egress-style calls share one permit row", async () => {
		const identity = await site();
		const put = vi.fn();
		const remove = vi.fn();
		const session = tenantSession(identity, { put, delete: remove });
		await session.put("key", "value");
		const [first] = await permitIds(identity.siteId);
		expect(first).toBeDefined();
		await Promise.all(
			Array.from({ length: 99 }, (_, i) =>
				i % 2 ? session.put(`key-${i}`, "value") : session.delete(`key-${i}`),
			),
		);
		expect(put.mock.calls.length + remove.mock.calls.length).toBe(100);
		// Exact permits would have inserted and deleted 100 rows with random ids.
		expect(await permitIds(identity.siteId)).toEqual([first]);
		await reservationExpiry();
		expect(await permitIds(identity.siteId)).toEqual([]);
	}, 20_000);

	test("a restore waits for every in-flight borrower of a shared row and refuses new ones", async () => {
		const identity = await site();
		const finishers: Array<() => void> = [];
		const put = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishers.push(resolve);
				}),
		);
		const session = tenantSession(identity, { put });
		const first = session.put("one", "value");
		await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
		const second = session.put("two", "value");
		await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
		expect(await permitIds(identity.siteId)).toHaveLength(1);

		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, fence)).toBe(0);
		await expect(session.put("late", "value")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(tenantR2(identity).delete("media/key")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(put).toHaveBeenCalledTimes(2);

		finishers[0]!();
		await first;
		await reservationExpiry();
		// One borrower still runs: the row outlives the reuse window.
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(1);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		finishers[1]!();
		await second;
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		// The rotated epoch admits only callers pinned to the new epoch.
		await expect(session.put("stale", "value")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		const next = tenantSession({ ...identity, restoreEpoch: 1 }, { put });
		finishers.length = 0;
		const fresh = next.put("fresh", "value");
		await vi.waitFor(() => expect(finishers).toHaveLength(1));
		finishers[0]!();
		await fresh;
	}, 30_000);

	test.each(["pause", "deprovision"] as const)(
		"%s refuses new borrowers and cannot drain past a live shared row",
		async (operation) => {
			const identity = await site();
			let finish!: () => void;
			const put = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			const session = tenantSession(identity, { put });
			const pending = session.put("one", "value");
			await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
			if (operation === "pause")
				await platformD1
					.prepare("UPDATE cms_sites SET status = 'paused' WHERE id = ?")
					.bind(identity.siteId)
					.run();
			else
				await platformD1
					.prepare("INSERT INTO cms_deprovision_operations (id) VALUES (?)")
					.bind(identity.siteId)
					.run();
			await expect(session.put("late", "value")).rejects.toBeInstanceOf(
				CmsRestoreFenceUnavailableError,
			);
			expect(put).toHaveBeenCalledTimes(1);
			await reservationExpiry();
			expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(1);
			finish();
			await pending;
			expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(0);
		},
		30_000,
	);
});

test("buffered pages do not rotate revisions for zero-row tenant maintenance", async () => {
	const identity = await site();
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	const counts = await runInDurableObject(
		namespace.get(namespace.idFromName(identity.slug)),
		async (instance: EmDashDB) => {
			const platform = (
				Reflect.get(instance, "env") as { PLATFORM_DB: D1Database }
			).PLATFORM_DB;
			const statements: string[] = [];
			const originalPrepare = platform.prepare.bind(platform);
			const spy = vi.spyOn(platform, "prepare").mockImplementation((sql) => {
				statements.push(sql);
				return originalPrepare(sql);
			});
			const outer = new PublicRestorePermits();
			const tasks: Promise<unknown>[] = [];
			try {
				for (let page = 0; page < 10; page++) {
					const response = await withCmsRestoreResponsePermit(
						createDbQueryClient(platform),
						identity,
						async () => {
							await instance.queryWithRestorePermit(
								identity,
								"SELECT * FROM content",
							);
							await instance.queryWithRestorePermit(
								identity,
								"DELETE FROM content WHERE id = -1",
							);
							return new Response("page", {
								headers: { "Content-Type": "text/html" },
							});
						},
						undefined,
						outer.forRequest((task) => tasks.push(task)),
					);
					if (!response.admitted) throw new Error("expected page admission");
					expect(await response.value.text()).toBe("page");
				}
				return {
					queries: statements.length,
					revisions: statements.filter((sql) =>
						/^update "cms_sites"/i.test(sql),
					).length,
				};
			} finally {
				await Promise.all(tasks);
				spy.mockRestore();
			}
		},
	);
	console.info(
		"CMS core D1 queries for 10 buffered pages before reservation cleanup",
		counts,
	);
	expect(counts.revisions).toBe(0);
	expect(counts.queries).toBe(30);
}, 20_000);

test("page-cache revision changes on tenant writes but not reads", async () => {
	const identity = await site();
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	const stub = namespace.get(namespace.idFromName(identity.slug));
	const revision = async () =>
		(
			await platformD1
				.prepare(
					"SELECT json_extract(config, '$.pageCacheRevision') AS revision FROM cms_sites WHERE id = ?",
				)
				.bind(identity.siteId)
				.first<{ revision: string | null }>()
		)?.revision;
	const before = await revision();
	await stub.queryWithRestorePermit(identity, "SELECT * FROM content");
	expect(await revision()).toBe(before);
	await stub.queryWithRestorePermit(
		identity,
		'UPDATE "content" SET title = ? WHERE id = -1',
		["Nothing"],
	);
	expect(await revision()).toBe(before);
	await stub.query(
		"CREATE TABLE _emdash_404_log (id INTEGER PRIMARY KEY, hits INTEGER)",
	);
	await stub.queryWithRestorePermit(
		identity,
		'INSERT INTO "_emdash_404_log" (id, hits) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET hits = hits + 1',
	);
	expect(await revision()).toBe(before);
	await stub.batchQueryWithRestorePermit(identity, [
		{ sql: "UPDATE _emdash_404_log SET hits = hits + 1 WHERE id = 1" },
	]);
	expect(await revision()).toBe(before);
	await stub.query(
		"CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT, revision TEXT)",
	);
	const optionUpsert =
		'insert into "options" ("name", "value", "revision") values (?, ?, ?) on conflict ("name") do update set "value" = ?, "revision" = ?';
	await stub.query(
		"CREATE TABLE _emdash_cron_tasks (id INTEGER PRIMARY KEY, status TEXT, locked_at TEXT, plugin_id TEXT DEFAULT 'example', task_name TEXT DEFAULT 'test', schedule TEXT DEFAULT '* * * * *', is_oneshot INTEGER DEFAULT 0, data TEXT, next_run_at TEXT DEFAULT 'before', enabled INTEGER DEFAULT 1)",
	);
	const recoverLocks =
		"UPDATE _emdash_cron_tasks SET status = 'idle', locked_at = NULL WHERE status = 'running' AND locked_at < ?";
	await stub.queryWithRestorePermit(identity, recoverLocks, ["now"]);
	expect(await revision()).toBe(before);
	await stub.query(
		"INSERT INTO _emdash_cron_tasks (id, status, locked_at) VALUES (1, 'running', 'before')",
	);
	await stub.batchQueryWithRestorePermit(identity, [
		{ sql: recoverLocks, params: ["now"] },
	]);
	const claimTasks =
		"UPDATE _emdash_cron_tasks SET status = 'running', locked_at = ? WHERE id IN (SELECT id FROM _emdash_cron_tasks WHERE next_run_at <= ? AND status = 'idle' AND enabled = 1 ORDER BY next_run_at ASC LIMIT 10) RETURNING id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at";
	expect(
		await stub.queryWithRestorePermit(identity, claimTasks, ["now", "now"]),
	).toMatchObject({ rows: [{ id: 1 }] });
	expect(
		await stub.queryWithRestorePermit(identity, claimTasks, ["now", "now"]),
	).toMatchObject({ rows: [] });
	expect(await revision()).toBe(before);
	await stub.queryWithRestorePermit(identity, optionUpsert, [
		"system:scheduler:last_completed_at",
		'"now"',
		"r1",
		'"now"',
		"r1",
	]);
	expect(await revision()).toBe(before);
	await stub.query(
		"CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, data TEXT)",
	);
	await stub.query(
		"CREATE TABLE _plugin_indexes (plugin_id TEXT, collection TEXT, index_name TEXT, fields TEXT, PRIMARY KEY (plugin_id, collection, index_name))",
	);
	const indexSql =
		"CREATE INDEX IF NOT EXISTS \"idx_plugin_example_items_created_at\" ON _plugin_storage(plugin_id, collection, json_extract(data, '$.created_at'))";
	const indexRow = {
		sql: 'insert into "_plugin_indexes" ("plugin_id", "collection", "index_name", "fields") values (?, ?, ?, ?) on conflict ("plugin_id", "collection", "index_name") do update set "fields" = ?',
		params: [
			"example",
			"items",
			"idx_plugin_example_items_created_at",
			'["created_at"]',
			'["created_at"]',
		],
	};
	await stub.queryWithRestorePermit(identity, indexSql);
	await stub.queryWithRestorePermit(identity, indexRow.sql, indexRow.params);
	await stub.batchQueryWithRestorePermit(identity, [
		{ sql: indexSql },
		indexRow,
	]);
	await stub.queryWithRestorePermit(
		identity,
		'DROP INDEX IF EXISTS "idx_plugin_example_items_created_at"',
	);
	await stub.queryWithRestorePermit(
		identity,
		'DELETE FROM "_plugin_indexes" WHERE plugin_id = ? AND collection = ? AND index_name = ?',
		["example", "items", "idx_plugin_example_items_created_at"],
	);
	expect(await revision()).toBe(before);
	await stub.queryWithRestorePermit(identity, optionUpsert, [
		"site:title",
		'"New title"',
		"r2",
		'"New title"',
		"r2",
	]);
	const afterSettings = await revision();
	expect(afterSettings).not.toBe(before);
	await stub.queryWithRestorePermit(
		identity,
		"INSERT INTO content (title) VALUES (?)",
		["Published"],
	);
	const published = await revision();
	expect(published).not.toBe(afterSettings);
	await stub.query("CREATE VIEW editable_content AS SELECT * FROM content");
	await stub.query(
		"CREATE TRIGGER edit_content INSTEAD OF UPDATE ON editable_content BEGIN UPDATE content SET title = NEW.title WHERE id = OLD.id; END",
	);
	expect(
		await stub.queryWithRestorePermit(
			identity,
			"UPDATE editable_content SET title = 'Via trigger'",
		),
	).toMatchObject({ changes: 0 });
	const triggered = await revision();
	expect(triggered).not.toBe(published);
	await stub.queryWithRestorePermit(
		identity,
		"WITH errors AS (SELECT * FROM _emdash_404_log) UPDATE content SET title = ? WHERE EXISTS (SELECT 1 FROM errors)",
		["Published with error context"],
	);
	const contextualWrite = await revision();
	expect(contextualWrite).not.toBe(triggered);
	await stub.batchQueryWithRestorePermit(identity, [
		{ sql: "UPDATE _emdash_404_log SET hits = hits + 1 WHERE id = 1" },
		{ sql: "UPDATE content SET title = ?", params: ["Republished"] },
	]);
	expect(await revision()).not.toBe(contextualWrite);
	const beforePluginWrite = await revision();
	await stub.batchQueryWithRestorePermit(identity, [
		{ sql: indexSql },
		indexRow,
		{
			sql: "INSERT INTO _plugin_storage (plugin_id, collection, data) VALUES (?, ?, ?)",
			params: ["example", "items", '{"created_at":"now"}'],
		},
	]);
	expect(await revision()).not.toBe(beforePluginWrite);
});
