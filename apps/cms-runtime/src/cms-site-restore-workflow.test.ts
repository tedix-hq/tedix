import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
	readReceipt: vi.fn(),
	advanceReceipt: vi.fn(),
	readCapture: vi.fn(),
	captureRecovery: vi.fn(),
	listMediaPage: vi.fn(),
	digestMedia: vi.fn(),
	deleteMedia: vi.fn(),
	restoreMedia: vi.fn(),
	assertMedia: vi.fn(),
	closeFence: vi.fn(),
	getFence: vi.fn(),
	countPermits: vi.fn(),
	reconcileOuter: vi.fn(),
	releaseFence: vi.fn(),
	readAuthority: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("@tedix/db/client", () => ({ createDbClient: vi.fn(() => ({})) }));
vi.mock("@tedix/db/queries/cms-restore-fences", () => ({
	closeCmsRestoreFence: mocks.closeFence,
	countCmsRestorePermitsForSite: mocks.countPermits,
	reconcileCmsRestoreOuterPermits: mocks.reconcileOuter,
	getCmsRestoreFenceState: mocks.getFence,
	releaseCmsRestoreFence: mocks.releaseFence,
}));
vi.mock("./cms-site-restore-receipt", () => ({
	readCmsSiteRestoreReceipt: mocks.readReceipt,
	advanceCmsSiteRestoreReceipt: mocks.advanceReceipt,
}));
vi.mock("./cms-recovery-workflow", () => ({
	readVerifiedCmsRecoveryCapture: mocks.readCapture,
	readRecoveryAuthority: mocks.readAuthority,
	captureCmsRecovery: mocks.captureRecovery,
	cmsRecoveryPrefix: (siteId: string, captureId: string) =>
		`recovery/${siteId}/${captureId}/`,
}));
vi.mock("./tenant-media-backup", () => ({
	listMediaPage: mocks.listMediaPage,
	digestSourceMediaObject: mocks.digestMedia,
	deleteSourceMediaObject: mocks.deleteMedia,
	restoreSourceMediaObject: mocks.restoreMedia,
	assertSourceMediaMatches: mocks.assertMedia,
}));

import {
	cmsSiteRestoreUndoCaptureId,
	reconcileCmsSiteMedia,
	runCmsSiteRestore,
} from "./cms-site-restore-workflow";

const identity = {
	siteId: "11111111-1111-4111-8111-111111111111",
	slug: "disposable",
	captureId: "22222222-2222-4222-8222-222222222222",
	generation: "33333333-3333-4333-8333-333333333333",
};
const record = (key: string) => ({
	key,
	size: 3,
	etag: `old-${key}`,
	sha256: createHash("sha256").update(key).digest("hex"),
	contentType: "image/png",
});

describe("general CMS site restore", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.deleteMedia.mockResolvedValue(undefined);
		mocks.restoreMedia.mockResolvedValue(undefined);
		mocks.assertMedia.mockResolvedValue(undefined);
	});

	it("reconciles missing, changed and extra media before whole-bucket proof", async () => {
		const records = [record("same"), record("changed"), record("missing")];
		mocks.listMediaPage.mockResolvedValue({
			objects: [
				{ key: "same", size: 3, etag: "new-same" },
				{ key: "changed", size: 3, etag: "new-changed" },
				{ key: "extra", size: 1, etag: "extra" },
			],
		});
		mocks.digestMedia.mockImplementation(async ({ key }: { key: string }) => ({
			bytes: 3,
			sha256: record(key).sha256,
			contentType: key === "same" ? "image/png" : "text/plain",
		}));
		const env = {
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
			RECOVERY_STORAGE: {},
		};
		const digest = await reconcileCmsSiteMedia(env as never, identity, records);
		expect(mocks.deleteMedia).toHaveBeenCalledWith(
			expect.objectContaining({ slug: identity.slug, key: "extra" }),
		);
		expect(
			mocks.restoreMedia.mock.calls.map(([args]) => args.record.key),
		).toEqual(["changed", "missing"]);
		expect(mocks.restoreMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				backupKey: `recovery/${identity.siteId}/${identity.captureId}/media/missing`,
			}),
		);
		expect(mocks.assertMedia).toHaveBeenCalledWith(
			expect.objectContaining({ records }),
		);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not mutate media when inventory pagination repeats", async () => {
		mocks.listMediaPage.mockResolvedValue({
			objects: [],
			cursor: "same-cursor",
		});
		await expect(
			reconcileCmsSiteMedia(
				{
					CF_ACCOUNT_ID: "account",
					CLOUDFLARE_R2_API_TOKEN: "token",
					RECOVERY_STORAGE: {},
				} as never,
				identity,
				[],
			),
		).rejects.toThrow("cursor repeated");
		expect(mocks.deleteMedia).not.toHaveBeenCalled();
		expect(mocks.restoreMedia).not.toHaveBeenCalled();
	});

	it("rejects a v1 capture before closing the D1 fence", async () => {
		mocks.readReceipt.mockResolvedValue({
			receipt: {
				...identity,
				version: 1,
				phase: "claimed",
				mode: "restore",
				bundle: { version: 7, etag: "bundle-7" },
			},
			etag: "receipt-etag",
		});
		mocks.readCapture.mockResolvedValue({
			manifest: { version: 1, bundle: { version: 7, etag: "bundle-7" } },
			records: [],
		});
		const step = {
			do: async (_name: string, callback: () => Promise<unknown>) => callback(),
		};
		await expect(
			runCmsSiteRestore({ RECOVERY_STORAGE: {} } as never, step as never, {
				...identity,
				mode: "restore",
			}),
		).rejects.toThrow("verified v2 capture");
		expect(mocks.closeFence).not.toHaveBeenCalled();
	});

	it("accepts a completed Workflow replay without a second provider effect", async () => {
		mocks.readReceipt.mockResolvedValue({
			receipt: {
				...identity,
				version: 1,
				phase: "released",
				mode: "roundtrip",
			},
			etag: "receipt-etag",
		});
		const step = { do: vi.fn() };
		await expect(
			runCmsSiteRestore({ RECOVERY_STORAGE: {} } as never, step as never, {
				...identity,
				mode: "roundtrip",
			}),
		).resolves.toEqual({
			status: "released",
			generation: identity.generation,
			mode: "roundtrip",
		});
		expect(step.do).not.toHaveBeenCalled();
		expect(mocks.closeFence).not.toHaveBeenCalled();
	});

	it("rejects a second mode for the same restore generation", async () => {
		mocks.readReceipt.mockResolvedValue({
			receipt: { ...identity, version: 1, phase: "claimed", mode: "restore" },
			etag: "receipt-etag",
		});
		const step = { do: vi.fn() };
		await expect(
			runCmsSiteRestore({ RECOVERY_STORAGE: {} } as never, step as never, {
				...identity,
				mode: "roundtrip",
			}),
		).rejects.toThrow("receipt mode changed");
		expect(step.do).not.toHaveBeenCalled();
	});

	it("keeps the exact fence closed when a PITR schedule outcome is unknown", async () => {
		const target = {
			version: 2,
			bookmark: "target-bookmark",
			databaseDigest: "a".repeat(64),
			bundle: { version: 7, etag: "bundle-7" },
		};
		const undo = {
			...target,
			bookmark: "undo-bookmark",
			databaseDigest: "b".repeat(64),
		};
		let receipt = {
			...identity,
			version: 1 as const,
			phase: "claimed",
			mode: "restore" as const,
			createdAt: "2026-09-29T00:00:00.000Z",
			updatedAt: "2026-09-29T00:00:00.000Z",
			bundle: target.bundle,
		};
		mocks.readReceipt.mockImplementation(async () => ({
			receipt,
			etag: "etag",
		}));
		mocks.advanceReceipt.mockImplementation(
			async (_storage, _current, next) => {
				receipt = next;
				return { receipt, etag: "new-etag" };
			},
		);
		mocks.readCapture.mockImplementation(async (_storage, selected) => ({
			manifest: selected.captureId === identity.captureId ? target : undo,
			records: [],
		}));
		mocks.captureRecovery.mockResolvedValue(undo);
		mocks.readAuthority.mockResolvedValue({
			siteId: identity.siteId,
			bundle: target.bundle,
		});
		mocks.closeFence.mockResolvedValue(true);
		mocks.getFence.mockResolvedValue({
			fence: { generation: identity.generation, captureId: identity.captureId },
			inFlight: 0,
		});
		mocks.countPermits.mockResolvedValue(0);
		const schedule = vi
			.fn()
			.mockRejectedValue(new Error("provider response lost"));
		const env = {
			RECOVERY_STORAGE: {
				put: vi.fn().mockResolvedValue({ etag: "control-etag" }),
				get: vi.fn().mockResolvedValue({
					etag: "control-etag",
					json: async () => ({ state: "running" }),
				}),
			},
			PLATFORM_DB: {},
			DB_DO: {
				idFromName: (slug: string) => slug,
				get: () => ({ scheduleCmsSiteRestore: schedule }),
			},
		};
		const doStep = vi.fn(
			async (
				_name: string,
				configOrCallback: unknown,
				maybeCallback?: () => Promise<unknown>,
			) => {
				const callback =
					typeof configOrCallback === "function"
						? (configOrCallback as () => Promise<unknown>)
						: maybeCallback!;
				return callback();
			},
		);
		await expect(
			runCmsSiteRestore(env as never, { do: doStep } as never, {
				...identity,
				mode: "restore",
			}),
		).rejects.toThrow("provider response lost");
		expect(receipt.phase).toBe("target-schedule-intent");
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				bookmark: target.bookmark,
				expectedDatabaseDigest: undo.databaseDigest,
				direction: "target",
			}),
		);
		expect(mocks.releaseFence).not.toHaveBeenCalled();
		expect(doStep).toHaveBeenCalledWith(
			"schedule-target-pitr",
			{ retries: { limit: 0, delay: "1 second" } },
			expect.any(Function),
		);
	});

	it("releases only after target and undo SQL, media and bundle parity", async () => {
		const target = {
			version: 2,
			bookmark: "target-bookmark",
			databaseDigest: "a".repeat(64),
			bundle: { version: 7, etag: "bundle-7" },
		};
		const undo = {
			...target,
			bookmark: "undo-bookmark",
			databaseDigest: "b".repeat(64),
		};
		let receipt = {
			...identity,
			version: 1 as const,
			phase: "claimed",
			mode: "roundtrip" as const,
			createdAt: "2026-09-29T00:00:00.000Z",
			updatedAt: "2026-09-29T00:00:00.000Z",
			bundle: target.bundle,
		};
		let currentDigest = undo.databaseDigest;
		mocks.readReceipt.mockImplementation(async () => ({
			receipt,
			etag: "etag",
		}));
		mocks.advanceReceipt.mockImplementation(
			async (_storage, _current, next) => {
				receipt = next;
				return { receipt, etag: "new-etag" };
			},
		);
		mocks.readCapture.mockImplementation(async (_storage, selected) => ({
			manifest: selected.captureId === identity.captureId ? target : undo,
			records: [],
		}));
		mocks.captureRecovery.mockResolvedValue(undo);
		mocks.readAuthority.mockResolvedValue({
			siteId: identity.siteId,
			bundle: target.bundle,
		});
		mocks.closeFence.mockResolvedValue(true);
		mocks.getFence.mockResolvedValue({
			fence: { generation: identity.generation, captureId: identity.captureId },
			inFlight: 0,
		});
		mocks.countPermits.mockResolvedValue(0);
		mocks.listMediaPage.mockResolvedValue({ objects: [] });
		mocks.releaseFence.mockResolvedValue(true);
		const schedule = vi.fn(async ({ direction, expectedDatabaseDigest }) => {
			if (expectedDatabaseDigest !== currentDigest)
				throw new Error("wrong pre-schedule SQL digest");
			return {
				undoBookmark:
					direction === "target" ? "undo-bookmark" : "redo-bookmark",
			};
		});
		const restart = vi.fn(async ({ direction }) => {
			currentDigest =
				direction === "target" ? target.databaseDigest : undo.databaseDigest;
		});
		const env = {
			RECOVERY_STORAGE: {
				put: vi.fn().mockResolvedValue({ etag: "control-etag" }),
				get: vi.fn().mockResolvedValue({
					etag: "control-etag",
					json: async () => ({ state: "running" }),
				}),
			},
			PLATFORM_DB: {},
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
			DB_DO: {
				idFromName: (slug: string) => slug,
				get: () => ({
					scheduleCmsSiteRestore: schedule,
					restartCmsSiteRestore: restart,
					captureRecoverySnapshot: async () => ({
						bookmark: "current-bookmark",
						databaseDigest: currentDigest,
					}),
				}),
			},
		};
		const doStep = vi.fn(
			async (
				_name: string,
				configOrCallback: unknown,
				maybeCallback?: () => Promise<unknown>,
			) =>
				(typeof configOrCallback === "function"
					? (configOrCallback as () => Promise<unknown>)
					: maybeCallback!)(),
		);
		await expect(
			runCmsSiteRestore(env as never, { do: doStep } as never, {
				...identity,
				mode: "roundtrip",
			}),
		).resolves.toEqual({
			status: "released",
			generation: identity.generation,
			mode: "roundtrip",
		});
		expect(receipt.phase).toBe("released");
		expect(schedule).toHaveBeenCalledTimes(2);
		expect(restart).toHaveBeenCalledTimes(2);
		expect(mocks.assertMedia).toHaveBeenCalledTimes(3);
		expect(mocks.reconcileOuter).toHaveBeenCalledWith(
			{},
			expect.objectContaining(identity),
		);
		expect(mocks.releaseFence).toHaveBeenCalledTimes(1);
	});

	it("derives a stable, distinct UUID for the private undo capture", () => {
		const first = cmsSiteRestoreUndoCaptureId(identity);
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(first).toBe(cmsSiteRestoreUndoCaptureId(identity));
		expect(first).not.toBe(identity.captureId);
	});
});
