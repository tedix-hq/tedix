import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	claimCmsCaptureCronPause,
	countCmsRestorePermitsForSite,
	drainCmsCaptureCronPause,
	enterCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import {
	reconcileScheduledCmsRestorePermits,
	withScheduledCmsRestorePermit,
} from "./scheduled-restore-permits";

const bindings = env as unknown as {
	PLATFORM_DB: D1Database;
	RECOVERY_STORAGE: R2Bucket;
};
const db = createDbQueryClient(bindings.PLATFORM_DB);
const storage = bindings.RECOVERY_STORAGE;

beforeAll(async () => {
	await bindings.PLATFORM_DB.exec(`
CREATE TABLE IF NOT EXISTS cms_sites (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cms_restore_permits (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'legacy', entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE IF NOT EXISTS cms_restore_fences (site_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cms_deprovision_operations (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cms_capture_cron_pauses (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL, expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER);
`);
});

async function site() {
	const siteId = crypto.randomUUID();
	const identity = { siteId, slug: `site-${siteId}`, restoreEpoch: 0 };
	await bindings.PLATFORM_DB.prepare(
		"INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')",
	)
		.bind(siteId, identity.slug)
		.run();
	return identity;
}

function loseCompletionResponse() {
	return new Proxy(storage, {
		get(target, property) {
			if (property === "put")
				return async (name: string, value: string) => {
					await target.put(name, value);
					throw new Error("completion response lost");
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("scheduled restore permit ownership", () => {
	test("unblocks capture after reconciling its completed orphan", async () => {
		const identity = await site();
		await expect(
			withScheduledCmsRestorePermit(
				db,
				loseCompletionResponse(),
				identity,
				async () => "done",
			),
		).rejects.toThrow("completion response lost");
		const capture = { ...identity, captureId: "capture" };
		await claimCmsCaptureCronPause(db, capture);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			await reconcileScheduledCmsRestorePermits(db, storage, identity),
		).toBe(1);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(true);
	});

	test("recovers a completed orphan and leaves active and historical permits fenced", async () => {
		const identity = await site();
		await expect(
			withScheduledCmsRestorePermit(
				db,
				loseCompletionResponse(),
				identity,
				async () => "done",
			),
		).rejects.toThrow("completion response lost");
		await enterCmsRestorePermit(db, {
			...identity,
			permitId: "unknown-owner",
			kind: "scheduled",
		});
		await bindings.PLATFORM_DB.prepare(
			"UPDATE cms_restore_permits SET entered_at = '2000-01-01' WHERE id = 'unknown-owner' AND site_id = ?",
		)
			.bind(identity.siteId)
			.run();
		const capture = { ...identity, captureId: "capture" };
		expect(await claimCmsCaptureCronPause(db, capture)).toBe(true);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			await reconcileScheduledCmsRestorePermits(db, storage, identity),
		).toBe(1);
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(1);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			await reconcileScheduledCmsRestorePermits(db, storage, identity),
		).toBe(0);
	});

	test("tolerates capture reconciliation racing the owner's cleanup", async () => {
		const identity = await site();
		const racingStorage = new Proxy(storage, {
			get(target, property) {
				if (property === "put")
					return async (name: string, value: string) => {
						const result = await target.put(name, value);
						expect(
							await reconcileScheduledCmsRestorePermits(db, storage, identity),
						).toBe(1);
						return result;
					};
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(
			withScheduledCmsRestorePermit(
				db,
				racingStorage,
				identity,
				async () => "done",
			),
		).resolves.toEqual({ admitted: true, value: "done" });
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(0);
	});

	test("releases a confirmed handler failure while preserving its error result", async () => {
		const identity = await site();
		const result = { ok: false, error: "handler failed" };
		await expect(
			withScheduledCmsRestorePermit(db, storage, identity, async () => result),
		).resolves.toEqual({ admitted: true, value: result });
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(0);
	});

	test("does not reclaim a running callback and drains only after it returns", async () => {
		const identity = await site();
		let finish!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const running = withScheduledCmsRestorePermit(
			db,
			storage,
			identity,
			async () => {
				entered();
				await pending;
				return "done";
			},
		);
		await started;
		const capture = { ...identity, captureId: "capture" };
		await claimCmsCaptureCronPause(db, capture);
		expect(
			await reconcileScheduledCmsRestorePermits(db, storage, identity),
		).toBe(0);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		finish();
		await expect(running).resolves.toEqual({ admitted: true, value: "done" });
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(true);
	});

	test("retains uncertain transport failures and refuses paused admission", async () => {
		const identity = await site();
		await expect(
			withScheduledCmsRestorePermit(db, storage, identity, async () => {
				throw new Error("RPC disconnected");
			}),
		).rejects.toThrow("RPC disconnected");
		expect(
			await reconcileScheduledCmsRestorePermits(db, storage, identity),
		).toBe(0);
		await claimCmsCaptureCronPause(db, { ...identity, captureId: "capture" });
		const run = vi.fn();
		expect(
			await withScheduledCmsRestorePermit(db, storage, identity, run),
		).toEqual({ admitted: false });
		expect(run).not.toHaveBeenCalled();
		expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(1);
	});

	test("never releases another kind, epoch, slug or site's permit", async () => {
		for (const changed of [
			{ kind: "nested" },
			{ kind: "legacy" },
			{ kind: "outer" },
			{ restoreEpoch: 1 },
			{ slug: "other" },
			{ siteId: "other" },
			{ permitId: "other" },
		]) {
			const identity = await site();
			await expect(
				withScheduledCmsRestorePermit(
					db,
					loseCompletionResponse(),
					identity,
					async () => {},
				),
			).rejects.toThrow();
			const page = await storage.list({
				prefix: `scheduled-permits/${identity.siteId}/`,
			});
			const object = await storage.get(page.objects[0]!.key);
			const receipt = await object!.json<Record<string, unknown>>();
			await storage.put(
				page.objects[0]!.key,
				JSON.stringify({ ...receipt, ...changed }),
			);
			const reconciliation = reconcileScheduledCmsRestorePermits(
				db,
				storage,
				identity,
			);
			if ("restoreEpoch" in changed)
				await expect(reconciliation).resolves.toBe(0);
			else await expect(reconciliation).rejects.toThrow("completion invalid");
			expect(await countCmsRestorePermitsForSite(db, identity.siteId)).toBe(1);
		}
	});
});
