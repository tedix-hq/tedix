import { env } from "cloudflare:workers";
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
import type { EmDashDB } from "./emdash-db";
import { CmsRestoreFenceUnavailableError } from "./tenant-restore-fence";

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
}, 20_000);

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

async function fixture() {
	const siteId = crypto.randomUUID();
	const identity = { siteId, slug: `plugin-${siteId}`, restoreEpoch: 0 };
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(siteId, identity.slug)
		.run();
	const coordinator = namespace.get(namespace.idFromName(identity.slug));
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
					query,
					runWithRestorePermit: (
						...args: Parameters<EmDashDB["runWithRestorePermit"]>
					) => {
						lastCall = Date.now();
						return coordinator.runWithRestorePermit(...args);
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
		bridge,
		query,
		operations,
		end: () => bridge.kvEnd(props.invocationId),
	};
}

describe("plugin KV shared restore permits", () => {
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
