import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const permit = vi.hoisted(() => ({ admit: true, enters: 0, leaves: 0 }));
vi.mock("@tedix/db/queries/cms-restore-fences", async (importOriginal) => ({
	...(await importOriginal<object>()),
	enterCmsRestorePermit: async () => {
		permit.enters++;
		return permit.admit;
	},
	leaveCmsRestorePermit: async () => {
		permit.leaves++;
		return true;
	},
}));

import { loadBundleModules } from "./index";

function bundleStore(
	initial: Record<string, string | ArrayBuffer>,
	onPut?: (key: string) => Promise<void>,
) {
	const objects = new Map(Object.entries(initial));
	const bucket = {
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined
				? null
				: new Response(value, {
						headers: {
							"content-type":
								typeof value === "string" ? "text/plain" : "application/gzip",
						},
					});
		},
		async put(key: string, value: ArrayBuffer) {
			await onPut?.(key);
			objects.set(key, value);
		},
	};
	return { bucket, objects };
}

describe("CMS immutable bundle packing", () => {
	beforeEach(() => {
		permit.admit = true;
		permit.enters = 0;
		permit.leaves = 0;
	});

	test("packs individual modules as gzip and reads them without the source objects", async () => {
		const prefix = "tedix/v1/";
		const { bucket, objects } = bundleStore({
			[`${prefix}manifest.json`]: JSON.stringify({
				mainModule: "entry.mjs",
				modules: ["entry.mjs", "chunks/a.mjs"],
			}),
			[`${prefix}entry.mjs`]: "export default 1;",
			[`${prefix}chunks/a.mjs`]: "export const a = 2;",
		});
		const env = { TENANT_BUNDLES: bucket, PLATFORM_DB: {} };
		const firstSpans: Record<string, number> = {};
		const first = await loadBundleModules(env as never, prefix, {
			spans: firstSpans,
			restoreIdentity: { siteId: "site-tedix", slug: "tedix", restoreEpoch: 0 },
		});
		expect(firstSpans["bundle.packed"]).toBe(0);
		expect(permit.enters).toBe(1);
		expect(permit.leaves).toBe(1);
		expect(
			objects.get(`${prefix}__tedix_packed_bundle.json.gz`),
		).toBeInstanceOf(ArrayBuffer);

		objects.delete(`${prefix}manifest.json`);
		objects.delete(`${prefix}entry.mjs`);
		objects.delete(`${prefix}chunks/a.mjs`);
		const secondSpans: Record<string, number> = {};
		const second = await loadBundleModules(env as never, prefix, {
			spans: secondSpans,
		});
		expect(second).toEqual(first);
		expect(secondSpans["bundle.packedGzip"]).toBe(1);
	});

	test("upgrades an existing JSON pack after a corrupt gzip read", async () => {
		const prefix = "tedix/v2/";
		const packed = {
			mainModule: "entry.mjs",
			modules: { "entry.mjs": { js: "export default 3;" } },
		};
		const { bucket, objects } = bundleStore({
			[`${prefix}__tedix_packed_bundle.json.gz`]: new Uint8Array([0, 1, 2])
				.buffer,
			[`${prefix}__tedix_packed_bundle.json`]: JSON.stringify(packed),
		});
		const env = { TENANT_BUNDLES: bucket, PLATFORM_DB: {} };
		const first = await loadBundleModules(env as never, prefix, {
			restoreIdentity: { siteId: "site-tedix", slug: "tedix", restoreEpoch: 0 },
		});
		expect(first).toEqual(packed);
		objects.delete(`${prefix}__tedix_packed_bundle.json`);
		const second = await loadBundleModules(env as never, prefix);
		expect(second).toEqual(packed);
	});

	test("does not write a lazy pack when the pinned permit is denied", async () => {
		const prefix = "tedix/v3/";
		const { bucket, objects } = bundleStore({
			[`${prefix}manifest.json`]: JSON.stringify({
				mainModule: "entry.mjs",
				modules: ["entry.mjs"],
			}),
			[`${prefix}entry.mjs`]: "export default 1;",
		});
		permit.admit = false;
		await loadBundleModules(
			{ TENANT_BUNDLES: bucket, PLATFORM_DB: {} } as never,
			prefix,
			{
				restoreIdentity: {
					siteId: "site-tedix",
					slug: "tedix",
					restoreEpoch: 0,
				},
			},
		);
		expect(permit.enters).toBe(1);
		expect(permit.leaves).toBe(0);
		expect(objects.has(`${prefix}__tedix_packed_bundle.json.gz`)).toBe(false);
	});

	test("holds the nested permit until the packed R2 write completes", async () => {
		const prefix = "tedix/v4/";
		let finishWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			finishWrite = resolve;
		});
		const { bucket } = bundleStore(
			{
				[`${prefix}manifest.json`]: JSON.stringify({
					mainModule: "entry.mjs",
					modules: ["entry.mjs"],
				}),
				[`${prefix}entry.mjs`]: "export default 1;",
			},
			async () => writeGate,
		);
		let loaded = false;
		const loading = loadBundleModules(
			{ TENANT_BUNDLES: bucket, PLATFORM_DB: {} } as never,
			prefix,
			{
				restoreIdentity: {
					siteId: "site-tedix",
					slug: "tedix",
					restoreEpoch: 0,
				},
			},
		).then(() => {
			loaded = true;
		});
		await vi.waitFor(() => expect(permit.enters).toBe(1));
		expect(loaded).toBe(false);
		expect(permit.leaves).toBe(0);
		finishWrite?.();
		await loading;
		expect(permit.leaves).toBe(1);
	});
});
