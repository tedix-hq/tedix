import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { uploadTenantBundle } from "@tedix/provisioning/cms";
import type { AppBindings } from "../types";
import { withExactCmsSiteRestorePermit } from "./cms-restore-permit";
import { publishStagedCmsBundle } from "./deploy-publish";

vi.mock("@tedix/provisioning/cms", () => ({ uploadTenantBundle: vi.fn() }));
vi.mock("./cms-restore-permit", () => ({
	withExactCmsSiteRestorePermit: vi.fn(),
}));

function jsonObject(value: unknown) {
	return { json: async () => value } as unknown as R2ObjectBody;
}

describe("publishStagedCmsBundle restore fence", () => {
	beforeEach(() => vi.resetAllMocks());

	function fixture(staticFilenames = ["asset.woff2"]) {
		const sourceRevision = {
			kind: "editable_source_digest" as const,
			value: "a".repeat(64),
		};
		const staging = {
			get: vi.fn(async (key: string) => {
				if (key.endsWith("/manifest.json"))
					return jsonObject({
						mainModule: "entry.mjs",
						files: ["entry.mjs"],
						sourceRevision,
					});
				if (key.endsWith("/files/entry.mjs"))
					return {
						arrayBuffer: async () => new TextEncoder().encode("entry").buffer,
					} as R2ObjectBody;
				if (key.endsWith("/static-manifest.json"))
					return jsonObject({ filenames: staticFilenames });
				if (
					staticFilenames.some((filename) =>
						key.endsWith(`/static/${filename}`),
					)
				)
					return {
						arrayBuffer: async () => new TextEncoder().encode("asset").buffer,
					} as R2ObjectBody;
				return null;
			}),
		};
		const bundles = {
			put: vi.fn(async (_key: string, _body: ArrayBuffer) => ({})),
		};
		const record = vi.fn(async () => {});
		const db = {} as D1Database;
		const input = {
			env: {
				DB: db,
				SITE_BUILDER_STORAGE: staging,
				BUNDLES_BUCKET: bundles,
			} as unknown as AppBindings,
			orgSlug: "site-a",
			site: { siteId: "site-a-id", slug: "site-a", restoreEpoch: 0 },
			stagingAttemptId: "attempt-1",
			summary: "Theme update",
			jobId: "job-1",
			nextBundleVersion: 7,
			expectedActiveVersion: 6,
			record,
		};
		vi.mocked(uploadTenantBundle).mockResolvedValue({
			humanAuthority: "unchanged",
			slug: "site-a",
			version: 7,
			etag: "etag-7",
			r2Prefix: "site-a/v7/",
			mainModule: "entry.mjs",
			modules: ["entry.mjs"],
			deployedAt: "2026-09-29T00:00:00.000Z",
			sourceRevision,
		});
		return { input, db, staging, bundles, record };
	}

	it("rejects a queued build when the site fence is closed before reservation", async () => {
		const { input, db, staging, bundles, record } = fixture();
		vi.mocked(withExactCmsSiteRestorePermit).mockRejectedValueOnce(
			new Error("CMS restore permit denied for site site-a"),
		);

		await expect(publishStagedCmsBundle(input)).rejects.toThrow(
			"CMS restore permit denied",
		);
		expect(withExactCmsSiteRestorePermit).toHaveBeenCalledWith(
			db,
			input.site,
			expect.any(Function),
		);
		expect(staging.get).not.toHaveBeenCalled();
		expect(uploadTenantBundle).not.toHaveBeenCalled();
		expect(bundles.put).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
	});

	it("holds the permit through delayed bundle upload, static writes, and publication record", async () => {
		const { input, bundles, record } = fixture();
		let finishUpload!: () => void;
		const uploadBlocked = new Promise<void>((resolve) => {
			finishUpload = resolve;
		});
		let released = false;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementationOnce(
			async (_db, _site, operation) => {
				try {
					return await operation();
				} finally {
					released = true;
				}
			},
		);
		const originalUpload = vi
			.mocked(uploadTenantBundle)
			.getMockImplementation()!;
		vi.mocked(uploadTenantBundle).mockImplementationOnce(async (...args) => {
			await uploadBlocked;
			return originalUpload(...args);
		});

		const publishing = publishStagedCmsBundle(input);
		await vi.waitFor(() => expect(uploadTenantBundle).toHaveBeenCalledOnce());
		expect(released).toBe(false);
		expect(bundles.put).not.toHaveBeenCalled();
		finishUpload();
		await publishing;
		expect(bundles.put).toHaveBeenCalledWith(
			"static/site-a/asset.woff2",
			expect.any(ArrayBuffer),
		);
		expect(record).toHaveBeenCalledWith(
			"publish-bundle",
			"complete",
			"Bundle published",
			expect.any(Object),
		);
		expect(released).toBe(true);
	});

	it("releases the permit when a static asset write fails", async () => {
		const { input, bundles, record } = fixture();
		const events: string[] = [];
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementationOnce(
			async (_db, _site, operation) => {
				try {
					return await operation();
				} finally {
					events.push("released");
				}
			},
		);
		bundles.put.mockRejectedValueOnce(new Error("R2 unavailable"));

		await expect(publishStagedCmsBundle(input)).rejects.toThrow(
			"R2 unavailable",
		);
		expect(uploadTenantBundle).toHaveBeenCalledOnce();
		expect(record).not.toHaveBeenCalled();
		expect(events).toEqual(["released"]);
	});

	it("waits for a delayed sibling static upload before releasing a failed publish", async () => {
		const { input, bundles, record } = fixture(["asset.woff2", "other.woff2"]);
		let released = false;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementationOnce(
			async (_db, _site, operation) => {
				try {
					return await operation();
				} finally {
					released = true;
				}
			},
		);
		let finishSecond!: () => void;
		const secondPending = new Promise<void>((resolve) => {
			finishSecond = resolve;
		});
		let secondEntered!: () => void;
		const secondStarted = new Promise<void>((resolve) => {
			secondEntered = resolve;
		});
		bundles.put.mockImplementation(async (key: string) => {
			if (key.endsWith("/asset.woff2")) throw new Error("first upload failed");
			secondEntered();
			await secondPending;
			return {};
		});

		const publishing = publishStagedCmsBundle(input);
		const outcome = expect(publishing).rejects.toThrow("first upload failed");
		await secondStarted;
		expect(released).toBe(false);
		expect(record).not.toHaveBeenCalled();
		finishSecond();
		await outcome;
		expect(released).toBe(true);
		expect(record).not.toHaveBeenCalled();
	});
});
