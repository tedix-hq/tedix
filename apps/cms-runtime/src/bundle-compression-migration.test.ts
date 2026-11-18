import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { getNextTenantBundleForCompression } from "@tedix/db/queries/tenant-bundles";
import type { TenantBundle } from "@tedix/db/schema/tenant-bundles";
import { migrateTenantBundleCompression } from "./bundle-compression-migration";
import { loadBundleModules } from "./index";

vi.mock("@tedix/db/queries/tenant-bundles", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tenant-bundles")>()),
	getNextTenantBundleForCompression: vi.fn(),
}));

const identity = { siteId: "site-acme", slug: "acme", restoreEpoch: 0 };
const checkpoint = "bundle-compression-migration/v1/site-acme.json";
const gzipKey = (version: number) =>
	`acme/v${version}/__tedix_packed_bundle.json.gz`;
const packed = {
	mainModule: "entry.mjs",
	modules: { "entry.mjs": { js: "export default 1;" } },
};

async function gzip(value: unknown) {
	return new Response(
		new Blob([JSON.stringify(value)])
			.stream()
			.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
}

function fixture() {
	const objects = new Map<string, string | ArrayBuffer>();
	const writes: string[] = [];
	let admitted = true;
	let held = 0;
	const bucket = {
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined ? null : new Response(value);
		},
		async put(key: string, value: string | ArrayBuffer) {
			expect(held).toBeGreaterThan(0);
			writes.push(key);
			objects.set(key, value);
		},
	} as unknown as R2Bucket;
	const env = {
		TENANT_BUNDLES: bucket,
		RECOVERY_STORAGE: bucket,
		DB_DO: {
			idFromName: (name: string) => name,
			get: () => ({
				async runWithRestorePermit(
					_identity: unknown,
					run: () => Promise<void>,
				) {
					if (!admitted) throw new Error("fenced");
					held++;
					try {
						await run();
					} finally {
						held--;
					}
				},
			}),
		} as unknown as DurableObjectNamespace,
	};
	const bundles = [1, 2, 3].map(
		(version) =>
			({
				slug: "acme",
				version,
				r2Prefix: `acme/v${version}/`,
				mainModule: "entry.mjs",
				modulesJson: ["entry.mjs"],
				isActive: version === 3,
			}) as TenantBundle,
	);
	vi.mocked(getNextTenantBundleForCompression).mockImplementation(
		async (_db, slug, cursor) => {
			expect(slug).toBe("acme");
			const pending = bundles.filter((bundle) => bundle.version > cursor);
			return {
				bundle: pending[0] ?? null,
				total: bundles.length,
				remaining: pending.length,
			};
		},
	);
	const load = vi.fn((prefix: string) =>
		loadBundleModules(env as never, prefix, { restoreIdentity: identity }),
	);
	return {
		objects,
		writes,
		bundles,
		load,
		deny: () => {
			admitted = false;
		},
		run: (restoreEpoch = 0) =>
			migrateTenantBundleCompression(
				env,
				{} as never,
				{ ...identity, restoreEpoch },
				load,
			),
		report: () => JSON.parse(objects.get(checkpoint) as string),
	};
}

describe("scheduled bundle compression migration", () => {
	beforeEach(() => vi.clearAllMocks());
	test("converts retained and active versions one per tick and resumes with exact counts", async () => {
		const f = fixture();
		f.objects.set("acme/v1/__tedix_packed_bundle.json", JSON.stringify(packed));
		f.objects.set(
			"acme/v2/manifest.json",
			JSON.stringify({ mainModule: "entry.mjs", modules: ["entry.mjs"] }),
		);
		f.objects.set("acme/v2/entry.mjs", packed.modules["entry.mjs"].js);
		f.objects.set(gzipKey(3), await gzip(packed));
		await f.run();
		expect(f.report()).toMatchObject({
			converted: 1,
			alreadyCompressed: 0,
			remaining: 2,
			afterVersion: 1,
		});
		expect(f.load).toHaveBeenCalledTimes(1);
		await f.run();
		await f.run();
		await f.run();
		expect(f.report()).toMatchObject({
			total: 3,
			converted: 2,
			alreadyCompressed: 1,
			unreadable: 0,
			remaining: 0,
		});
		expect(f.writes.filter((key) => key.endsWith(".gz"))).toEqual([
			gzipKey(1),
			gzipKey(2),
		]);
		expect(f.objects.has("acme/v2/manifest.json")).toBe(true);
	});
	test("does not advance an unreadable version and retries it on the next tick", async () => {
		const f = fixture();
		await f.run();
		expect(f.report()).toMatchObject({
			converted: 0,
			afterVersion: 0,
			unreadable: 1,
			remaining: 3,
		});
		f.objects.set("acme/v1/__tedix_packed_bundle.json", JSON.stringify(packed));
		await f.run();
		expect(f.report()).toMatchObject({
			converted: 1,
			afterVersion: 1,
			unreadable: 0,
			remaining: 2,
		});
	});
	test("never counts a swallowed compressed write failure as converted", async () => {
		const f = fixture();
		f.load.mockResolvedValue(packed);
		await f.run();
		expect(f.report()).toMatchObject({
			converted: 0,
			afterVersion: 0,
			unreadable: 1,
			remaining: 3,
		});
	});
	test("reports corrupt or mismatched compressed packs without overwriting them", async () => {
		const f = fixture();
		for (const bytes of [
			new Uint8Array([0, 1]).buffer,
			await gzip({ ...packed, mainModule: "other.mjs" }),
		]) {
			f.objects.set(gzipKey(1), bytes);
			await f.run();
			expect(f.report()).toMatchObject({
				unreadable: 1,
				remaining: 3,
				afterVersion: 0,
			});
		}
		expect(f.load).not.toHaveBeenCalled();
	});
	test("refuses a catalog prefix outside the permitted tenant generation", async () => {
		const f = fixture();
		f.bundles[0]!.r2Prefix = "other/v1/";
		await f.run();
		expect(f.report()).toMatchObject({
			afterVersion: 0,
			unreadable: 1,
			remaining: 3,
		});
		expect(f.load).not.toHaveBeenCalled();
		expect(f.writes).toEqual([checkpoint]);
	});
	test("does no migration or checkpoint writes when restore admission fails", async () => {
		const f = fixture();
		f.deny();
		await expect(f.run()).rejects.toThrow("CMS restore fence unavailable");
		expect(f.load).not.toHaveBeenCalled();
		expect(f.writes).toEqual([]);
	});
	test("rescans after restore and includes a newly retained generation after completion", async () => {
		const f = fixture();
		for (const bundle of f.bundles)
			f.objects.set(gzipKey(bundle.version), await gzip(packed));
		await f.run();
		await f.run();
		await f.run();
		expect(f.report().remaining).toBe(0);
		f.bundles.push({ ...f.bundles[2]!, version: 4, r2Prefix: "acme/v4/" });
		f.objects.set(gzipKey(4), await gzip(packed));
		await f.run();
		expect(f.report().alreadyCompressed).toBe(4);
		await f.run(1);
		expect(f.report()).toMatchObject({
			afterVersion: 1,
			alreadyCompressed: 1,
			remaining: 3,
			restoreEpoch: 1,
		});
	});
});
