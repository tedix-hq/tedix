import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
	deleteTenantBundleRow,
	listPrunableTenantBundles,
	listTenantBundles,
} from "@tedix/db/queries/tenant-bundles";
import {
	enterCmsRestorePermit,
	leaveCompletedCmsScheduledPermit,
} from "@tedix/db/queries/cms-restore-fences";
import type { TenantBundle } from "@tedix/db/schema/tenant-bundles";
import { retainTenantBundles } from "./bundle-retention";

vi.mock("@tedix/db/queries/tenant-bundles", () => ({
	deleteTenantBundleRow: vi.fn(),
	listPrunableTenantBundles: vi.fn(),
	listTenantBundles: vi.fn(),
}));
vi.mock("@tedix/db/queries/cms-restore-fences", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cms-restore-fences")
	>()),
	enterCmsRestorePermit: vi.fn(),
	leaveCompletedCmsScheduledPermit: vi.fn(),
	leaveCmsRestorePermit: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

function fixture(slug = "tedix-landing") {
	const identity = { siteId: "site-example", slug, restoreEpoch: 4 };
	let held = false;
	let failDelete = false;
	let failRow = false;
	const objects = new Map<string, string>();
	const events: string[] = [];
	let rows = Array.from(
		{ length: 12 },
		(_, i) =>
			({
				id: `b${i + 1}`,
				slug,
				version: i + 1,
				r2Prefix: `${slug}/v${i + 1}/`,
				isActive: i === 11,
			}) as TenantBundle,
	);
	for (const row of rows) objects.set(`${row.r2Prefix}entry.mjs`, "js");
	for (let v = 3; v <= 10; v++)
		objects.set(`${slug}/v${v}/__tedix_packed_bundle.json.gz`, "gzip");
	vi.mocked(enterCmsRestorePermit).mockImplementation(async () => {
		held = true;
		return true;
	});
	vi.mocked(leaveCompletedCmsScheduledPermit).mockImplementation(async () => {
		held = false;
		return true;
	});
	vi.mocked(listTenantBundles).mockImplementation(async () => {
		expect(held).toBe(true);
		return rows;
	});
	vi.mocked(listPrunableTenantBundles).mockImplementation(
		async (_db, _slug, keep, evidence) => {
			expect(held).toBe(true);
			const rollback = rows
				.filter(
					(r) => !r.isActive && evidence.compressedVersions.includes(r.version),
				)
				.slice(-keep)
				.map((r) => r.version);
			return rows.filter(
				(r) =>
					!r.isActive &&
					r.version < 12 &&
					!rollback.includes(r.version) &&
					!evidence.referencedVersions.includes(r.version),
			);
		},
	);
	vi.mocked(deleteTenantBundleRow).mockImplementation(
		async (_db, _slug, version) => {
			expect(held).toBe(true);
			expect(
				[...objects.keys()].some((key) =>
					key.startsWith(`${slug}/v${version}/`),
				),
			).toBe(false);
			if (failRow) {
				failRow = false;
				throw new Error("row failed");
			}
			events.push(`row:${version}`);
			rows = rows.filter((r) => r.version !== version);
			return true;
		},
	);
	function bucket(recovery: boolean) {
		return {
			async head(key: string) {
				expect(held).toBe(true);
				return objects.has(key) ? {} : null;
			},
			async get(key: string) {
				expect(held).toBe(true);
				return objects.has(key)
					? { json: async () => JSON.parse(objects.get(key)!) }
					: null;
			},
			async put(key: string, value: string) {
				expect(held).toBe(true);
				objects.set(key, value);
			},
			async delete(keys: string | string[]) {
				if (
					recovery &&
					typeof keys === "string" &&
					keys.startsWith("scheduled-permits/")
				)
					expect(held).toBe(false);
				else expect(held).toBe(true);
				if (failDelete && !recovery) throw new Error("object failed");
				for (const key of typeof keys === "string" ? [keys] : keys) {
					events.push(key);
					objects.delete(key);
				}
			},
			async list({
				prefix,
				delimiter,
				cursor,
			}: {
				prefix: string;
				delimiter?: string;
				cursor?: string;
			}) {
				expect(held).toBe(true);
				const keys = [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.sort();
				if (delimiter)
					return {
						objects: [],
						delimitedPrefixes: [
							...new Set(
								keys
									.filter((k) => k.slice(prefix.length).includes("/"))
									.map(
										(k) => prefix + k.slice(prefix.length).split("/")[0] + "/",
									),
							),
						],
						truncated: false,
					};
				// Force pagination before deleting: tokens are key-based, not indexes.
				const remaining = keys.filter((k) => !cursor || k > cursor);
				return {
					objects: remaining.slice(0, 1).map((key) => ({ key })),
					truncated: remaining.length > 1,
					cursor: remaining[0],
				};
			},
		} as unknown as R2Bucket;
	}
	return {
		objects,
		events,
		deny: () => vi.mocked(enterCmsRestorePermit).mockResolvedValue(false),
		failDelete: () => {
			failDelete = true;
		},
		failRow: () => {
			failRow = true;
		},
		run: () =>
			retainTenantBundles(
				{ TENANT_BUNDLES: bucket(false), RECOVERY_STORAGE: bucket(true) },
				{} as never,
				identity,
				{ waitUntil() {}, abort: vi.fn() },
			),
		report: () =>
			JSON.parse(objects.get(`bundle-retention/v1/${identity.siteId}.json`)!),
	};
}

test("keeps active, five newest compressed rollback targets, and capture/restore references; bounds and paginates deletes", async () => {
	const f = fixture();
	for (const [index, prefix] of [
		"recovery/site-example/capture/",
		"recovery/site-drills/site-example/copy/",
		"recovery/restores/site-example/generation/",
	].entries()) {
		f.objects.set(
			`${prefix}${prefix.includes("restores") ? "receipt" : "manifest"}.json`,
			JSON.stringify({
				siteId: "site-example",
				slug: "tedix-landing",
				bundle: { version: index + 1 },
			}),
		);
	}
	await f.run();
	expect(f.report()).toMatchObject({
		before: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
		kept: [1, 2, 3, 6, 7, 8, 9, 10, 12],
		deleted: [4, 5, 11],
		after: [1, 2, 3, 6, 7, 8, 9, 10, 12],
	});
	for (const version of [1, 2, 3, 6, 7, 8, 9, 10, 12])
		expect(f.objects.has(`tedix-landing/v${version}/entry.mjs`)).toBe(true);
	await f.run();
	expect(f.report().after).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 12]);
	await f.run();
	expect(f.report().deleted).toEqual([]);
});

test("no storage calls or deletion without restore admission", async () => {
	const f = fixture();
	f.deny();
	await f.run();
	expect(listTenantBundles).not.toHaveBeenCalled();
	expect(deleteTenantBundleRow).not.toHaveBeenCalled();
	expect(f.events).toEqual([]);
});

test("other sites never enter retention", async () => {
	const f = fixture("other");
	await f.run();
	expect(listTenantBundles).not.toHaveBeenCalled();
	expect(deleteTenantBundleRow).not.toHaveBeenCalled();
	expect(enterCmsRestorePermit).not.toHaveBeenCalled();
});

test("missing prefix after row failure is idempotent", async () => {
	const f = fixture();
	f.failRow();
	await expect(f.run()).rejects.toThrow("row failed");
	expect(f.report().deleted).toEqual([]);
	await f.run();
	expect(f.report().deleted).toEqual([1, 2, 3]);
});

test("object failure preserves the row and reports partial progress", async () => {
	const f = fixture();
	f.failDelete();
	await expect(f.run()).rejects.toThrow("object failed");
	expect(deleteTenantBundleRow).not.toHaveBeenCalled();
	expect(f.report().before).toEqual(f.report().after);
});

test("incomplete or corrupt capture inventory closes pruning", async () => {
	const f = fixture();
	f.objects.set(
		"recovery/site-example/capture/control.json",
		JSON.stringify({ state: "running" }),
	);
	await expect(f.run()).rejects.toThrow("inventory incomplete");
	expect(deleteTenantBundleRow).not.toHaveBeenCalled();
	f.objects.set(
		"recovery/site-example/capture/manifest.json",
		JSON.stringify({
			siteId: "wrong",
			slug: "tedix-landing",
			bundle: { version: 1 },
		}),
	);
	await expect(f.run()).rejects.toThrow("reference invalid");
	expect(deleteTenantBundleRow).not.toHaveBeenCalled();
});
