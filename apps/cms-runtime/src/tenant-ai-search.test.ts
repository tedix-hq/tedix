import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreEpoch,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";
import {
	TenantAiSearch,
	type TenantAiSearchNamespace,
} from "./tenant-ai-search";
import { TENANT_AI_SEARCH_LOGICAL_NAME } from "./tenant-ai-search-policy";
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

async function site() {
	const siteId = crypto.randomUUID();
	const slug = `tenant-${siteId}`;
	await platformD1
		.prepare("INSERT INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')")
		.bind(siteId, slug)
		.run();
	return { siteId, slug, instanceId: `instance-${siteId}`, restoreEpoch: 0 };
}

function facade(
	identity: Awaited<ReturnType<typeof site>>,
	namespace: TenantAiSearchNamespace,
	platformDb: D1Database = platformD1,
): TenantAiSearch {
	return Object.assign(Object.create(TenantAiSearch.prototype), {
		ctx: { props: identity },
		env: { AI_SEARCH: namespace, PLATFORM_DB: platformDb },
	}) as TenantAiSearch;
}

function provider() {
	const upload = vi.fn().mockResolvedValue({ id: "item-1" });
	const remove = vi.fn().mockResolvedValue(undefined);
	const update = vi.fn().mockResolvedValue({ updated: true });
	const info = vi.fn().mockResolvedValue({ id: "instance" });
	const search = vi.fn().mockResolvedValue({ results: [] });
	const instance = { info, update, search, items: { upload, delete: remove } };
	const get = vi.fn().mockReturnValue(instance);
	const create = vi.fn().mockResolvedValue(instance);
	return {
		namespace: { get, create },
		get,
		create,
		upload,
		remove,
		update,
		info,
		search,
	};
}

describe("tenant AI Search restore permit", () => {
	test("drains a delayed item upload, then denies writes on a closed site", async () => {
		const identity = await site();
		const service = provider();
		let finish!: (value: { id: string }) => void;
		service.upload.mockImplementationOnce(
			() => new Promise<{ id: string }>((resolve) => (finish = resolve)),
		);
		const entrypoint = facade(identity, service.namespace);
		const instance = entrypoint.get(TENANT_AI_SEARCH_LOGICAL_NAME);
		const pending = instance.items.upload("page", "body");
		await vi.waitFor(async () =>
			expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(1),
		);
		const fence = { ...identity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
		await expect(instance.items.delete("item-1")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(
			instance.update({ custom_metadata: {} }),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		await expect(
			entrypoint.create({ id: TENANT_AI_SEARCH_LOGICAL_NAME }),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		expect(service.remove).not.toHaveBeenCalled();
		expect(service.update).not.toHaveBeenCalled();
		expect(service.create).not.toHaveBeenCalled();
		finish({ id: "item-1" });
		await expect(pending).resolves.toEqual({ id: "item-1" });
		expect((await getCmsRestoreFenceState(db, identity)).inFlight).toBe(0);
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		await expect(instance.items.delete("item-1")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		const currentEpoch = await getCmsRestoreEpoch(db, identity);
		expect(currentEpoch).toBe(1);
		const fresh = facade(
			{ ...identity, restoreEpoch: currentEpoch! },
			service.namespace,
		);
		await expect(
			fresh.get(TENANT_AI_SEARCH_LOGICAL_NAME).items.delete("item-1"),
		).resolves.toBeUndefined();
		expect(service.remove).toHaveBeenCalledWith("item-1");
	});

	test("releases a failed provider call and isolates another site", async () => {
		const closedIdentity = await site();
		const openIdentity = await site();
		const fence = { ...closedIdentity, generation: "g1", captureId: "c1" };
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		const service = provider();
		service.upload.mockRejectedValueOnce(new Error("AI Search failed"));
		const open = facade(openIdentity, service.namespace);
		const instance = open.get(TENANT_AI_SEARCH_LOGICAL_NAME);
		await expect(instance.items.upload("page", "body")).rejects.toThrow(
			"AI Search failed",
		);
		expect((await getCmsRestoreFenceState(db, openIdentity)).inFlight).toBe(0);
		await expect(
			open.create({ id: TENANT_AI_SEARCH_LOGICAL_NAME }),
		).resolves.toBeDefined();
		await expect(instance.update({ custom_metadata: {} })).resolves.toEqual({
			updated: true,
		});
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
	});

	test("D1 failure denies writes but leaves read methods unchanged", async () => {
		const identity = await site();
		const service = provider();
		const brokenD1 = {
			prepare: () => {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const entrypoint = facade(identity, service.namespace, brokenD1);
		const instance = entrypoint.get(TENANT_AI_SEARCH_LOGICAL_NAME);
		await expect(instance.info()).resolves.toEqual({ id: "instance" });
		await expect(instance.search({ query: "hello" })).resolves.toEqual({
			results: [],
		});
		await expect(instance.items.upload("page", "body")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(instance.items.delete("item-1")).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		await expect(
			instance.update({ custom_metadata: {} }),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		await expect(
			entrypoint.create({ id: TENANT_AI_SEARCH_LOGICAL_NAME }),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		expect(service.upload).not.toHaveBeenCalled();
		expect(service.remove).not.toHaveBeenCalled();
		expect(service.update).not.toHaveBeenCalled();
		expect(service.create).not.toHaveBeenCalled();
		expect(service.get).toHaveBeenCalledWith(identity.instanceId);
	});
});
