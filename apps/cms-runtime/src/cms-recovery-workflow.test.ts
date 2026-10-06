import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";

const authority = vi.hoisted(() => ({
	getCmsSiteBySlug: vi.fn(),
	listTenantBundleVersions: vi.fn(),
}));
const capturePause = vi.hoisted(() => ({
	abort: vi.fn(),
	claim: vi.fn(),
	drain: vi.fn(),
	assert: vi.fn(),
	release: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: vi.fn(() => ({})) }));
vi.mock("@tedix/db/query-client", () => ({
	createDbQueryClient: vi.fn(() => ({})),
}));
vi.mock("@tedix/db/queries/cms-restore-fences", () => ({
	abortCmsCaptureCronPause: capturePause.abort,
	claimCmsCaptureCronPause: capturePause.claim,
	drainCmsCaptureCronPause: capturePause.drain,
	assertCmsCaptureCronPause: capturePause.assert,
	releaseCmsCaptureCronPause: capturePause.release,
}));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteBySlug: authority.getCmsSiteBySlug,
}));
vi.mock("@tedix/provisioning/cms", () => ({
	listTenantBundleVersions: authority.listTenantBundleVersions,
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import {
	captureCmsRecovery,
	CmsRecoveryWorkflow,
	isCmsRecoveryControl,
	isCmsRecoveryManifest,
	purgeCmsRecoveryObjects,
	readVerifiedCmsRecoveryCapture,
	CMS_RECOVERY_DIGEST_ALGORITHM,
	type CmsRecoveryControl,
} from "./cms-recovery-workflow";

const control: CmsRecoveryControl = {
	version: 1,
	siteId: "site-1",
	slug: "site",
	captureId: "capture-1",
	createdAt: "2026-09-29T00:00:00.000Z",
	state: "queued",
};
const databaseDigest = "a".repeat(64);

describe("CMS recovery workflow", () => {
	beforeEach(() => {
		for (const fn of Object.values(capturePause)) fn.mockReset();
		authority.getCmsSiteBySlug.mockReset().mockResolvedValue({
			id: "site-1",
			status: "active",
		});
		authority.listTenantBundleVersions
			.mockReset()
			.mockResolvedValue([{ isActive: true, version: 7, etag: "bundle-7" }]);
	});

	it("drains scheduled permits before the first SQL digest and releases before verification", async () => {
		const events: string[] = [];
		capturePause.claim.mockImplementation(async () => {
			events.push("pause-claimed");
			return true;
		});
		capturePause.drain
			.mockImplementationOnce(async () => {
				events.push("drain-blocked");
				return false;
			})
			.mockImplementation(async () => {
				events.push("drain-complete");
				return true;
			});
		capturePause.assert.mockResolvedValue(true);
		capturePause.release.mockImplementation(async () => {
			events.push("pause-released");
			return true;
		});
		const snapshot = vi.fn(async () => {
			events.push("database-snapshot");
			return { bookmark: "bookmark", databaseDigest };
		});
		let currentControl: CmsRecoveryControl = { ...control };
		const put = vi.fn(async (key: string, value: string) => {
			if (key.endsWith("/control.json")) {
				currentControl = JSON.parse(value) as CmsRecoveryControl;
				events.push(`control-${currentControl.state}`);
			}
			return {};
		});
		const env = {
			PLATFORM_DB: {},
			DB_DO: {
				idFromName: (slug: string) => slug,
				get: () => ({ captureRecoverySnapshot: snapshot }),
			},
			RECOVERY_STORAGE: {
				put,
				get: async (key: string) => ({
					json: async () =>
						key.endsWith("/control.json") ? currentControl : [],
				}),
			},
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				}),
			),
		);
		const step = {
			do: async (_name: string, run: () => Promise<unknown>) => run(),
			sleep: vi.fn(async () => {}),
		};
		const workflow = Object.assign(
			Object.create(CmsRecoveryWorkflow.prototype) as CmsRecoveryWorkflow,
			{ env },
		);
		await expect(
			workflow.run(
				{
					payload: {
						siteId: control.siteId,
						slug: control.slug,
						captureId: control.captureId,
					},
				} as never,
				step as never,
			),
		).resolves.toEqual({ captureId: control.captureId, status: "verified" });
		expect(capturePause.drain).toHaveBeenCalledTimes(2);
		expect(step.sleep).toHaveBeenCalledOnce();
		expect(capturePause.release).toHaveBeenCalledOnce();
		expect(events).toEqual([
			"pause-claimed",
			"drain-blocked",
			"drain-complete",
			"control-running",
			"database-snapshot",
			"database-snapshot",
			"pause-released",
			"control-verified",
		]);
		expect(currentControl.state).toBe("verified");
		vi.unstubAllGlobals();
	});

	it("retries steps inside the workflow and replays a lost release response safely", async () => {
		let released = false;
		capturePause.claim.mockResolvedValue(true);
		capturePause.drain.mockResolvedValue(true);
		capturePause.assert.mockImplementation(async () => !released);
		capturePause.release.mockImplementation(async () => {
			if (released) return true; // Exact row was already deleted.
			released = true;
			return true;
		});
		const objects = new Map<string, string>();
		const controlKey = "recovery/site-1/capture-1/control.json";
		objects.set(controlKey, JSON.stringify(control));
		const env = {
			PLATFORM_DB: {},
			DB_DO: {
				idFromName: (slug: string) => slug,
				get: () => ({
					captureRecoverySnapshot: async () => ({
						bookmark: "bookmark",
						databaseDigest,
					}),
				}),
			},
			RECOVERY_STORAGE: {
				put: vi.fn(async (key: string, value: string) => {
					objects.set(key, value);
					return {};
				}),
				get: vi.fn(async (key: string) => {
					const value = objects.get(key);
					return value === undefined
						? null
						: { json: async () => JSON.parse(value) };
				}),
			},
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
		};
		const requestedPages: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				requestedPages.push(
					Number(new URL(input).searchParams.get("per_page")),
				);
				return Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				});
			}),
		);
		const completed = new Map<string, unknown>();
		let mediaInterrupted = false;
		let releaseResponseLost = false;
		const step = {
			do: async (name: string, run: () => Promise<unknown>) => {
				if (completed.has(name)) return completed.get(name);
				if (name === "copy-media-page-0" && !mediaInterrupted) {
					mediaInterrupted = true;
					// Native step retries happen before step.do rejects.
					expect(capturePause.abort).not.toHaveBeenCalled();
				}
				const result = await run();
				if (name === "release-capture-cron-pause" && !releaseResponseLost) {
					releaseResponseLost = true;
					// Retry after the release succeeded but its response was lost.
					await run();
				}
				completed.set(name, result);
				return result;
			},
			sleep: vi.fn(async () => {}),
		};
		const workflow = Object.assign(
			Object.create(CmsRecoveryWorkflow.prototype) as CmsRecoveryWorkflow,
			{ env },
		);
		const event = { payload: control } as never;
		await expect(workflow.run(event, step as never)).resolves.toMatchObject({
			status: "verified",
		});
		expect(JSON.parse(objects.get(controlKey)!).state).toBe("verified");
		await expect(workflow.run(event, step as never)).resolves.toMatchObject({
			status: "verified",
		});
		expect(capturePause.claim).toHaveBeenCalledOnce();
		expect(capturePause.drain).toHaveBeenCalledOnce();
		expect(capturePause.assert).toHaveBeenCalledTimes(2);
		expect(capturePause.abort).not.toHaveBeenCalled();
		expect(capturePause.release).toHaveBeenCalledTimes(2);
		expect(requestedPages).toEqual([100, 10, 100]);
		vi.unstubAllGlobals();
	});

	it("aborts an undrained terminal failure and retains the original error if cleanup fails", async () => {
		capturePause.claim.mockResolvedValue(true);
		capturePause.drain.mockResolvedValue(false);
		capturePause.abort.mockRejectedValue(new Error("cleanup unavailable"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const step = {
			do: async (_name: string, run: () => Promise<unknown>) => run(),
			sleep: vi.fn(async () => {}),
		};
		const workflow = Object.assign(
			Object.create(CmsRecoveryWorkflow.prototype) as CmsRecoveryWorkflow,
			{ env: { PLATFORM_DB: {} } },
		);
		await expect(
			workflow.run({ payload: control } as never, step as never),
		).rejects.toThrow("CMS recovery scheduled writes did not drain");
		expect(capturePause.abort).toHaveBeenCalledExactlyOnceWith({}, control);
		expect(capturePause.release).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
		log.mockRestore();
	});

	it("cleans an exact pause after capture work exhausts its retries", async () => {
		capturePause.claim.mockResolvedValue(true);
		capturePause.drain.mockResolvedValue(true);
		capturePause.abort.mockResolvedValue(1);
		const failure = new Error("capture storage unavailable");
		const step = {
			do: async (_name: string, run: () => Promise<unknown>) => run(),
			sleep: vi.fn(),
		};
		const workflow = Object.assign(
			Object.create(CmsRecoveryWorkflow.prototype) as CmsRecoveryWorkflow,
			{
				env: {
					PLATFORM_DB: {},
					RECOVERY_STORAGE: {
						get: async () => {
							throw failure;
						},
					},
				},
			},
		);
		await expect(
			workflow.run({ payload: control } as never, step as never),
		).rejects.toBe(failure);
		expect(capturePause.abort).toHaveBeenCalledExactlyOnceWith({}, control);
	});

	it("writes a v2 manifest when the SQL digest is stable despite bookmark drift", async () => {
		const startedAt = Date.parse("2026-09-29T00:00:00.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(startedAt);
		const snapshot = vi
			.fn()
			.mockResolvedValueOnce({ bookmark: "bookmark-1", databaseDigest })
			.mockResolvedValueOnce({ bookmark: "bookmark-2", databaseDigest });
		const writes: string[] = [];
		const env = {
			DB_DO: {
				idFromName: vi.fn((slug: string) => slug),
				get: vi.fn(() => ({ captureRecoverySnapshot: snapshot })),
			},
			RECOVERY_STORAGE: {
				put: vi.fn(async (key: string) => {
					writes.push(key);
					return {};
				}),
				get: vi.fn(async (key: string) => ({
					json: async () => (key.endsWith("/control.json") ? control : []),
				})),
			},
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				}),
			),
		);
		const step = {
			do: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
				if (name === "verify-source-stability")
					vi.setSystemTime(startedAt + 2 * 24 * 60 * 60 * 1000);
				return fn();
			}),
		};
		const assertPause = vi.fn(async () => true);
		const result = await captureCmsRecovery(
			env as never,
			step as never,
			{
				siteId: "site-1",
				slug: "site",
				captureId: "capture-1",
			},
			assertPause,
		);
		expect(result.bookmark).toBe("bookmark-1");
		expect(result).toMatchObject({
			version: 2,
			digestAlgorithm: CMS_RECOVERY_DIGEST_ALGORITHM,
			databaseDigest,
		});
		expect(result.capturedAt).toBe(new Date(startedAt).toISOString());
		expect(result.retainUntil).toBe(
			new Date(startedAt + 29 * 24 * 60 * 60 * 1000).toISOString(),
		);
		expect(writes.at(-1)).toBe("recovery/site-1/capture-1/manifest.json");
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(assertPause).toHaveBeenCalledOnce();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("does not publish a manifest when the SQL digest changes", async () => {
		const snapshot = vi
			.fn()
			.mockResolvedValueOnce({ bookmark: "bookmark-1", databaseDigest })
			.mockResolvedValueOnce({
				bookmark: "bookmark-1",
				databaseDigest: "b".repeat(64),
			});
		const put = vi.fn(async () => ({}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				}),
			),
		);
		await expect(
			captureCmsRecovery(
				{
					DB_DO: {
						idFromName: vi.fn((slug: string) => slug),
						get: vi.fn(() => ({ captureRecoverySnapshot: snapshot })),
					},
					RECOVERY_STORAGE: {
						put,
						get: vi.fn(async (key: string) => ({
							json: async () => (key.endsWith("/control.json") ? control : []),
						})),
					},
					CF_ACCOUNT_ID: "account",
					CLOUDFLARE_R2_API_TOKEN: "token",
				} as never,
				{
					do: async (_name: string, fn: () => Promise<unknown>) => fn(),
				} as never,
				{
					siteId: "site-1",
					slug: "site",
					captureId: "capture-1",
				},
			),
		).rejects.toThrow("database changed");
		expect(put).not.toHaveBeenCalledWith(
			expect.stringContaining("manifest.json"),
			expect.anything(),
			expect.anything(),
		);
		vi.unstubAllGlobals();
	});

	it("retries verification with the checkpointed first bookmark and digest", async () => {
		const snapshot = vi
			.fn()
			.mockResolvedValueOnce({ bookmark: "first", databaseDigest })
			.mockResolvedValueOnce({
				bookmark: "changed",
				databaseDigest: "b".repeat(64),
			})
			.mockResolvedValueOnce({ bookmark: "later", databaseDigest });
		const checkpoints = new Map<string, unknown>();
		const step = {
			do: vi.fn(async (name: string, run: () => Promise<unknown>) => {
				if (checkpoints.has(name)) return checkpoints.get(name);
				const value = await run();
				checkpoints.set(name, value);
				return value;
			}),
		};
		const put = vi.fn(async () => ({}));
		const env = {
			DB_DO: {
				idFromName: (slug: string) => slug,
				get: () => ({ captureRecoverySnapshot: snapshot }),
			},
			RECOVERY_STORAGE: {
				put,
				get: async (key: string) => ({
					json: async () => (key.endsWith("/control.json") ? control : []),
				}),
			},
			CF_ACCOUNT_ID: "account",
			CLOUDFLARE_R2_API_TOKEN: "token",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				}),
			),
		);
		const params = {
			siteId: control.siteId,
			slug: control.slug,
			captureId: control.captureId,
		};
		await expect(
			captureCmsRecovery(env as never, step as never, params),
		).rejects.toThrow("database changed");
		expect(checkpoints.has("capture-authority")).toBe(true);
		expect(put).not.toHaveBeenCalledWith(
			expect.stringContaining("manifest.json"),
			expect.anything(),
			expect.anything(),
		);
		const replay = await captureCmsRecovery(
			env as never,
			step as never,
			params,
		);
		expect(replay).toMatchObject({
			version: 2,
			bookmark: "first",
			databaseDigest,
		});
		expect(snapshot).toHaveBeenCalledTimes(3);
		vi.unstubAllGlobals();
	});

	it("rejects control ownership mismatch and invalid retention timestamps", () => {
		expect(
			isCmsRecoveryControl(control, {
				siteId: "other-site",
				slug: "site",
				captureId: "capture-1",
			}),
		).toBe(false);
		expect(
			isCmsRecoveryManifest(
				{
					version: 1,
					siteId: "site-1",
					slug: "site",
					captureId: "capture-1",
					capturedAt: "2026-09-29T00:00:00.000Z",
					retainUntil: "invalid",
					bookmark: "opaque",
					bundle: { version: 1, etag: "etag" },
					media: { count: 0, bytes: 0 },
				},
				{ siteId: "site-1", slug: "site", captureId: "capture-1" },
			),
		).toBe(false);
	});

	it("reads valid v1 captures and rejects malformed or unknown v2 digests", () => {
		const capturedAt = new Date().toISOString();
		const legacy = {
			version: 1,
			siteId: control.siteId,
			slug: control.slug,
			captureId: control.captureId,
			capturedAt,
			retainUntil: new Date(
				Date.parse(capturedAt) + 29 * 24 * 60 * 60 * 1000,
			).toISOString(),
			bookmark: "legacy-bookmark",
			bundle: { version: 7, etag: "bundle-7" },
			media: {
				count: 0,
				bytes: 0,
				pageCount: 1,
				sourceInventorySha256: "a".repeat(64),
			},
		};
		const identity = {
			siteId: control.siteId,
			slug: control.slug,
			captureId: control.captureId,
		};
		expect(isCmsRecoveryManifest(legacy, identity)).toBe(true);
		const v2 = {
			...legacy,
			version: 2,
			digestAlgorithm: CMS_RECOVERY_DIGEST_ALGORITHM,
			databaseDigest,
		};
		expect(isCmsRecoveryManifest(v2, identity)).toBe(true);
		expect(
			isCmsRecoveryManifest(
				{ ...v2, media: { ...v2.media, count: 10_000, pageCount: 1000 } },
				identity,
			),
		).toBe(true);
		for (const invalid of [
			{ ...v2, databaseDigest: undefined },
			{ ...v2, databaseDigest: "A".repeat(64) },
			{ ...v2, databaseDigest: "a".repeat(63) },
			{ ...v2, digestAlgorithm: "cms-site-sqlite-v1" },
			{ ...v2, version: 3 },
			{ ...v2, media: { ...v2.media, count: 10_001 } },
			{ ...v2, media: { ...v2.media, pageCount: 1001 } },
		])
			expect(isCmsRecoveryManifest(invalid, identity)).toBe(false);
	});

	it("returns a verified replay without copying or resetting its terminal control", async () => {
		const capturedAt = new Date().toISOString();
		const manifest = {
			...control,
			capturedAt,
			retainUntil: new Date(
				Date.parse(capturedAt) + 29 * 24 * 60 * 60 * 1000,
			).toISOString(),
			bookmark: "bookmark-1",
			bundle: { version: 7, etag: "bundle-7" },
			media: {
				count: 0,
				bytes: 0,
				pageCount: 1,
				sourceInventorySha256: "a".repeat(64),
			},
		};
		const put = vi.fn();
		const get = vi.fn(async (key: string) => ({
			json: async () =>
				key.endsWith("control.json")
					? { ...control, state: "verified" }
					: manifest,
		}));
		const result = await captureCmsRecovery(
			{ RECOVERY_STORAGE: { get, put } } as never,
			{ do: vi.fn() } as never,
			{
				siteId: control.siteId,
				slug: control.slug,
				captureId: control.captureId,
			},
		);
		expect(result).toEqual(manifest);
		expect(put).not.toHaveBeenCalled();
		expect(authority.getCmsSiteBySlug).not.toHaveBeenCalled();
	});

	it("verifies page inventory and every private media byte before restore", async () => {
		const identity = { siteId: "site-1", slug: "site", captureId: "capture-1" };
		const prefix = "recovery/site-1/capture-1/";
		const bytes = new Uint8Array([1, 2, 3]);
		const record = {
			key: "image.png",
			size: 3,
			etag: "etag-1",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			contentType: "image/png",
		};
		const inventory = createHash("sha256")
			.update(JSON.stringify([record.key, record.size, record.etag]))
			.digest("hex");
		const capturedAt = new Date().toISOString();
		const manifest = {
			version: 1,
			...identity,
			capturedAt,
			retainUntil: new Date(
				Date.parse(capturedAt) + 29 * 24 * 60 * 60 * 1000,
			).toISOString(),
			bookmark: "bookmark-1",
			bundle: { version: 7, etag: "bundle-7" },
			media: {
				count: 1,
				bytes: 3,
				pageCount: 1,
				sourceInventorySha256: inventory,
			},
		};
		let page = [record];
		const storage = {
			get: vi.fn(async (key: string) => {
				if (key === `${prefix}control.json`)
					return {
						json: async () => ({
							...control,
							state: "verified",
							createdAt: capturedAt,
						}),
					};
				if (key === `${prefix}manifest.json`)
					return { json: async () => manifest };
				if (key === `${prefix}pages/00000000.json`)
					return { json: async () => page };
				if (key === `${prefix}media/image.png`)
					return { size: 3, body: new Response(bytes).body };
				return null;
			}),
		};
		const verified = await readVerifiedCmsRecoveryCapture(
			storage as unknown as R2Bucket,
			identity,
		);
		expect(verified.records).toEqual([record]);
		page = [{ ...record, etag: "tampered-etag" }];
		await expect(
			readVerifiedCmsRecoveryCapture(storage as unknown as R2Bucket, identity),
		).rejects.toThrow("media manifest mismatch");
	});

	it("invalidates the manifest before media deletion and resumes a partial purge", async () => {
		const prefix = "recovery/site-1/capture-1/";
		const objects = new Map<string, string>([
			[`${prefix}control.json`, JSON.stringify(control)],
			[`${prefix}manifest.json`, "private manifest"],
			[`${prefix}media/image.png`, "bytes"],
		]);
		const events: string[] = [];
		let failMediaOnce = true;
		const storage = {
			put: vi.fn(async (key: string, value: string) => {
				objects.set(key, value);
				events.push(`put:${key}`);
				return {};
			}),
			delete: vi.fn(async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					events.push(`delete:${key}`);
					if (key.endsWith("image.png") && failMediaOnce) {
						failMediaOnce = false;
						throw new Error("R2 interrupted");
					}
					objects.delete(key);
				}
			}),
			list: vi.fn(async () => ({
				objects: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
			})),
		};
		await expect(
			purgeCmsRecoveryObjects(storage as unknown as R2Bucket, control),
		).rejects.toThrow("R2 interrupted");
		expect(JSON.parse(objects.get(`${prefix}control.json`)!).state).toBe(
			"purging",
		);
		expect(objects.has(`${prefix}manifest.json`)).toBe(false);
		expect(events.indexOf(`delete:${prefix}manifest.json`)).toBeLessThan(
			events.indexOf(`delete:${prefix}media/image.png`),
		);
		await purgeCmsRecoveryObjects(storage as unknown as R2Bucket, {
			...control,
			state: "purging",
		});
		expect(objects.has(`${prefix}media/image.png`)).toBe(false);
		expect(JSON.parse(objects.get(`${prefix}control.json`)!).state).toBe(
			"purged",
		);
	});
});
