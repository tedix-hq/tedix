import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { PublicRestorePermits } from "./public-restore-permits";
import {
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { closeCmsRestoreFence } from "@tedix/db/queries/cms-restore-fences";
import { TenantPluginKvBridge } from "./tenant-plugin-executor";
import type { EmDashDB, EmDashDBStub } from "./emdash-db";
import { CmsRestoreFenceUnavailableError } from "./tenant-restore-fence";

const platformD1 = (env as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;
const db = createDbQueryClient(platformD1);
const namespace = (
	env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
).DB_DO;
let now = 0;
const cleanups: Array<() => Promise<void>> = [];
function clockFor(coordinator: DurableObjectStub<EmDashDB>) {
	return {
		now: () => now,
		schedule: (task: () => Promise<void>, delayMs: number) =>
			new Promise<void>((resolve, reject) => {
				const expiresAt = now + delayMs;
				cleanups.push(async () => {
					if (now < expiresAt) throw new Error("reservation has not expired");
					// Resolve waitUntil's promise in the object that created it.
					await runInDurableObject(coordinator, async () => {
						try {
							await task();
							resolve();
						} catch (error) {
							reject(error);
							throw error;
						}
					});
				});
			}),
	};
}
async function reservationExpiry() {
	now += 10_100;
	for (const cleanup of cleanups.splice(0)) await cleanup();
}
afterEach(async () => {
	await reservationExpiry();
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
			"CREATE TABLE IF NOT EXISTS cms_deprovision_operations (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued')",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_permits (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_capture_cron_pauses (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL, expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER)",
		)
		.run();
});

async function fixture(native = false) {
	const siteId = crypto.randomUUID();
	const identity = { siteId, slug: `plugin-${siteId}`, restoreEpoch: 0 };
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(siteId, identity.slug)
		.run();
	const coordinator = namespace.get(namespace.idFromName(identity.slug));
	await runInDurableObject(coordinator, (instance) => {
		Object.assign(instance, {
			databasePermits: new PublicRestorePermits(
				undefined,
				clockFor(coordinator),
			),
		});
	});
	await coordinator.query(
		"CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, id TEXT, data TEXT, revision TEXT, updated_at TEXT, PRIMARY KEY (plugin_id, collection, id))",
	);
	const query = vi.fn().mockResolvedValue({ rows: [] });
	const props = {
		tenantSlug: identity.slug,
		siteId,
		restoreEpoch: 0,
		pluginId: "sample",
		pluginVersion: "1.0.0",
		grants: ["kv:write"],
		invocationId: crypto.randomUUID(),
	};
	const bridge = Object.assign(Object.create(TenantPluginKvBridge.prototype), {
		ctx: { props },
		env: {
			PLATFORM_DB: {
				prepare: () => {
					throw new Error("unexpected per-call D1 access");
				},
			},
			DB_DO: {
				idFromName: (name: string) => name,
				get: () => ({
					runWithRestorePermit: (
						...args: Parameters<EmDashDB["runWithRestorePermit"]>
					) => coordinator.runWithRestorePermit(...args),
					query: async (sql: string, params?: unknown[]) => {
						await query();
						return native ? coordinator.query(sql, params) : { rows: [] };
					},
					queryWithRestorePermit: async (
						...args: Parameters<EmDashDB["queryWithRestorePermit"]>
					) => {
						if (native) {
							await query();
							return coordinator.queryWithRestorePermit(...args);
						}
						let result = { rows: [] };
						await coordinator.runWithRestorePermit(args[0], async () => {
							result = await query();
						});
						return result;
					},
				}),
			},
		},
	}) as TenantPluginKvBridge;
	bridge.kvBegin(props.invocationId);
	const operations = [
		() => bridge.kvSet("key", "value"),
		() => bridge.kvCompareAndSet("key", null, "value"),
		() => bridge.kvCompareAndDelete("key", "revision"),
		() => bridge.kvDelete("key"),
	];
	return {
		identity,
		coordinator,
		bridge,
		query,
		operations,
		end: () => bridge.kvEnd(props.invocationId),
	};
}

describe("plugin KV shared restore permits", () => {
	test("a delayed SQL RPC refuses an invocation admitted before the restore close", async () => {
		const { identity, coordinator, bridge, query, end } = await fixture(true);
		let dispatch!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		query.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					dispatch = resolve;
					entered();
				}),
		);
		const pending = bridge.kvSet("key", "stale");
		const rejected = expect(pending).rejects.toThrow(
			"CMS restore fence unavailable",
		);
		try {
			await started;
			expect(
				await closeCmsRestoreFence(db, {
					...identity,
					generation: "g",
					captureId: "c",
				}),
			).toBe(true);
			dispatch();
			await rejected;
			expect(
				(
					await (coordinator as unknown as EmDashDBStub).query(
						"SELECT * FROM _plugin_storage",
					)
				).rows,
			).toEqual([]);
		} finally {
			dispatch?.();
			end();
		}
	});

	test("each write runs once while reusing the same D1 reservation", async () => {
		const { identity, query, operations, end } = await fixture();
		try {
			let reservation: unknown;
			for (const operation of operations) {
				query.mockClear();
				await operation();
				expect(query).toHaveBeenCalledOnce();
				const rows = await platformD1
					.prepare("SELECT id FROM cms_restore_permits WHERE site_id = ?")
					.bind(identity.siteId)
					.all();
				expect(rows.results).toHaveLength(1);
				if (reservation) expect(rows.results).toEqual(reservation);
				reservation = rows.results;
			}
		} finally {
			end();
		}
	});

	test.each(["restore", "pause"] as const)(
		"%s refuses all KV writes before dispatch",
		async (reason) => {
			const { identity, query, operations, end } = await fixture();
			try {
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
				for (const operation of operations)
					await expect(operation()).rejects.toBeInstanceOf(
						CmsRestoreFenceUnavailableError,
					);
				expect(query).not.toHaveBeenCalled();
			} finally {
				end();
			}
		},
	);
});
