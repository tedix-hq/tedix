import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const dependencies = vi.hoisted(() => ({
	readRecoveryAuthority: vi.fn(),
	readVerifiedCmsRecoveryCapture: vi.fn(),
	assertSourceMediaMatches: vi.fn(),
	deleteSourceMediaObject: vi.fn(),
	restoreSourceMediaObject: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("./cms-recovery-workflow", () => ({
	cmsRecoveryPrefix: (siteId: string, captureId: string) =>
		`recovery/${siteId}/${captureId}/`,
	readRecoveryAuthority: dependencies.readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture: dependencies.readVerifiedCmsRecoveryCapture,
}));
vi.mock("./tenant-media-backup", () => ({
	assertSourceMediaMatches: dependencies.assertSourceMediaMatches,
	deleteSourceMediaObject: dependencies.deleteSourceMediaObject,
	restoreSourceMediaObject: dependencies.restoreSourceMediaObject,
}));

import {
	CMS_SITE_DRILL_BASELINE_DIGEST,
	CMS_SITE_DRILL_CAPTURE_ID,
	CMS_SITE_DRILL_INSTANCE_ID,
	CMS_SITE_DRILL_PREFIX,
	CMS_SITE_DRILL_RECEIPT_KEY,
	CMS_SITE_DRILL_SITE_ID,
	CMS_SITE_DRILL_SLUG,
	insertSiteDrillSentinel,
	readSiteDrillCapture,
	runCmsSiteRestoreDrill,
	type CmsSiteDrillReceipt,
} from "./cms-site-restore-drill-workflow";

const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const record = {
	key: "images/proof.png",
	size: 3,
	etag: "old-etag",
	sha256,
	contentType: "image/png",
};

function chunkedStream(value: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			const halfway = Math.floor(value.byteLength / 2);
			controller.enqueue(value.subarray(0, halfway));
			controller.enqueue(value.subarray(halfway));
			controller.close();
		},
	});
}

function harness(
	failAt?: string,
	failOnce = false,
	loseResultAt?: string,
	databaseDigestAfterMutation?: string,
	mediaBytes = bytes,
	corruptPrivateCopy = false,
	rejectPrivatePut = false,
) {
	let receipt: CmsSiteDrillReceipt | null = null;
	let sentinel: "absent" | "after" = "absent";
	let mediaPresent = true;
	let bookmark = "captured-bookmark";
	let databaseDigest = CMS_SITE_DRILL_BASELINE_DIGEST;
	const events: string[] = [];
	const copied = new Map<string, string | Uint8Array>();
	const storage = {
		get: vi.fn(async (key: string) => {
			if (key === CMS_SITE_DRILL_RECEIPT_KEY && receipt)
				return { json: async () => receipt };
			const saved = copied.get(key);
			if (typeof saved === "string")
				return { json: async () => JSON.parse(saved) };
			if (saved) return { size: saved.byteLength, body: chunkedStream(saved) };
			if (key.endsWith("/media/images%2Fproof.png"))
				return {
					size: mediaBytes.byteLength,
					body: chunkedStream(mediaBytes),
				};
			return null;
		}),
		put: vi.fn(
			async (
				key: string,
				value: string | ReadableStream<Uint8Array>,
				opts?: { onlyIf?: unknown },
			) => {
				if (key === CMS_SITE_DRILL_RECEIPT_KEY) {
					if (opts?.onlyIf && receipt) return null;
					receipt = JSON.parse(value as string) as CmsSiteDrillReceipt;
					events.push(`receipt:${receipt.phase}`);
				} else if (typeof value === "string") copied.set(key, value);
				else {
					if (
						rejectPrivatePut &&
						key.startsWith(CMS_SITE_DRILL_PREFIX + "media/")
					)
						throw new Error("private R2 put rejected");
					const chunks: Uint8Array[] = [];
					for await (const chunk of value) chunks.push(chunk);
					const stored = new Uint8Array(
						chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
					);
					let offset = 0;
					for (const chunk of chunks) {
						stored.set(chunk, offset);
						offset += chunk.byteLength;
					}
					if (
						corruptPrivateCopy &&
						key.startsWith(CMS_SITE_DRILL_PREFIX + "media/")
					)
						stored[0] = (stored[0] ?? 0) ^ 1;
					copied.set(key, stored);
					return { size: stored.byteLength };
				}
				return { size: typeof value === "string" ? value.length : 0 };
			},
		),
	};
	const stub = {
		readSiteDrillProof: vi.fn(async () => ({
			bookmark,
			sentinel,
			post: {
				id: "post-1",
				slug: "native-taxonomy-archive-proof",
				status: "published",
			},
			postDigest: "a".repeat(64),
			mediaKeys: [record.key],
			databaseDigest,
			schedulerHeartbeatValue: "2026-09-29T02:01:00.000Z",
			schedulerHeartbeatRevision: "frozen-revision",
		})),
		prepareSiteDrillMutation: vi.fn(async () => {
			if (receipt?.phase === "mutated") return;
			expect(receipt?.phase).toBe("claimed");
			sentinel = "after";
			bookmark = "mutated-bookmark";
			if (databaseDigestAfterMutation)
				databaseDigest = databaseDigestAfterMutation;
			receipt = { ...receipt!, phase: "mutated" };
			events.push("sentinel-mutated");
		}),
		scheduleSiteDrillRestore: vi.fn(async () => {
			expect(receipt?.phase).toBe("media-deleted");
			expect(mediaPresent).toBe(false);
			receipt = {
				...receipt!,
				phase: "restore-scheduled",
				undoBookmark: "undo-bookmark",
			};
			events.push("restore-scheduled");
		}),
		restartSiteDrill: vi.fn(async () => {
			if (receipt?.phase === "restore-scheduled") sentinel = "absent";
			if (receipt?.phase === "undo-scheduled") sentinel = "after";
			if (receipt?.phase === "final-scheduled") sentinel = "absent";
		}),
		scheduleSiteDrillUndo: vi.fn(async () => {
			receipt = {
				...receipt!,
				phase: "undo-scheduled",
				redoBookmark: "redo-bookmark",
			};
			events.push("undo-scheduled");
		}),
		scheduleSiteDrillFinalRestore: vi.fn(async () => {
			receipt = {
				...receipt!,
				phase: "final-scheduled",
				finalUndoBookmark: "final-undo-bookmark",
			};
			events.push("final-scheduled");
		}),
	};
	const env = {
		RECOVERY_STORAGE: storage,
		DB_DO: {
			idFromName: vi.fn((name: string) => name),
			get: vi.fn(() => stub),
		},
		CF_ACCOUNT_ID: "account",
		CLOUDFLARE_R2_API_TOKEN: "token",
	};
	const completed = new Map<string, unknown>();
	let failed = false;
	let lost = false;
	const step = {
		do: vi.fn(async (name: string, action: () => Promise<unknown>) => {
			if (completed.has(name)) return completed.get(name);
			if (name === failAt && (!failOnce || !failed)) {
				failed = true;
				throw new Error(`interrupted at ${name}`);
			}
			const result = await action();
			if (name === loseResultAt && !lost) {
				lost = true;
				throw new Error(`lost result at ${name}`);
			}
			completed.set(name, result);
			return result;
		}),
	};
	return {
		env,
		step,
		stub,
		events,
		get receipt() {
			return receipt;
		},
		get sentinel() {
			return sentinel;
		},
		get mediaPresent() {
			return mediaPresent;
		},
		setMediaPresent(value: boolean) {
			mediaPresent = value;
		},
		setBookmark(value: string) {
			bookmark = value;
		},
		setDatabaseDigest(value: string) {
			databaseDigest = value;
		},
	};
}

function wireMedia(
	h: ReturnType<typeof harness>,
	mediaBytes = bytes,
	forbidResponseBuffer = false,
) {
	dependencies.assertSourceMediaMatches
		.mockReset()
		.mockImplementation(async ({ missingKey }: { missingKey?: string }) => {
			if (h.mediaPresent === Boolean(missingKey))
				throw new Error("media parity mismatch");
		});
	dependencies.deleteSourceMediaObject
		.mockReset()
		.mockImplementation(async () => {
			h.setMediaPresent(false);
		});
	dependencies.restoreSourceMediaObject
		.mockReset()
		.mockImplementation(async () => {
			h.setMediaPresent(true);
		});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.includes("/posts/"))
				return new Response("Native taxonomy archive proof");
			if (!h.mediaPresent) return new Response("missing", { status: 404 });
			const response = new Response(chunkedStream(mediaBytes), { status: 200 });
			if (forbidResponseBuffer)
				vi.spyOn(response, "arrayBuffer").mockRejectedValue(
					new Error("public response was buffered"),
				);
			return response;
		}),
	);
}

describe("fixed disposable CMS restore drill", () => {
	beforeEach(() => {
		dependencies.readRecoveryAuthority.mockReset().mockResolvedValue({
			siteId: CMS_SITE_DRILL_SITE_ID,
			bundle: { version: 7, etag: "bundle" },
		});
		dependencies.readVerifiedCmsRecoveryCapture.mockReset().mockResolvedValue({
			manifest: {
				bookmark: "captured-bookmark",
				bundle: { version: 7, etag: "bundle" },
				capturedAt: new Date().toISOString(),
				media: { pageCount: 1 },
			},
			records: [record],
		});
	});

	it("creates and populates the sentinel in one DO SQL transaction", () => {
		let inside = false;
		const statements: string[] = [];
		const storage = {
			transactionSync: vi.fn((fn: () => void) => {
				inside = true;
				try {
					fn();
				} finally {
					inside = false;
				}
			}),
			sql: {
				exec: vi.fn((sql: string) => {
					expect(inside).toBe(true);
					statements.push(sql);
				}),
			},
		};
		insertSiteDrillSentinel(storage as unknown as DurableObjectStorage);
		expect(storage.transactionSync).toHaveBeenCalledOnce();
		expect(statements).toHaveLength(2);
	});

	it("publishes a private drill snapshot last and survives source capture purge", async () => {
		const h = harness();
		await readSiteDrillCapture(h.env.RECOVERY_STORAGE as never);
		const keys = h.env.RECOVERY_STORAGE.put.mock.calls.map((call) => call[0]);
		expect(keys.at(-1)).toBe(`${CMS_SITE_DRILL_PREFIX}manifest.json`);
		expect(CMS_SITE_DRILL_RECEIPT_KEY.startsWith(CMS_SITE_DRILL_PREFIX)).toBe(
			true,
		);
		dependencies.readVerifiedCmsRecoveryCapture.mockImplementation(
			async (_storage: unknown, _identity: unknown, prefix?: string) => {
				if (prefix !== CMS_SITE_DRILL_PREFIX)
					throw new Error("original capture purged");
				return {
					manifest: { bookmark: "captured-bookmark", media: { pageCount: 1 } },
					records: [record],
				};
			},
		);
		await expect(
			readSiteDrillCapture(h.env.RECOVERY_STORAGE as never),
		).resolves.toMatchObject({ records: [record] });
	});

	it("streams a media object larger than 1 MiB through the private copy and public proof", async () => {
		const largeBytes = new Uint8Array(1024 * 1024 + 17);
		for (let index = 0; index < largeBytes.length; index++)
			largeBytes[index] = index % 251;
		const largeRecord = {
			...record,
			size: largeBytes.byteLength,
			sha256: createHash("sha256").update(largeBytes).digest("hex"),
		};
		dependencies.readVerifiedCmsRecoveryCapture.mockResolvedValue({
			manifest: {
				bookmark: "captured-bookmark",
				bundle: { version: 7, etag: "bundle" },
				capturedAt: new Date().toISOString(),
				media: { pageCount: 1 },
			},
			records: [largeRecord],
		});
		const h = harness(undefined, false, undefined, undefined, largeBytes);
		wireMedia(h, largeBytes, true);
		const result = await runCmsSiteRestoreDrill(
			h.env as never,
			h.step as never,
			CMS_SITE_DRILL_INSTANCE_ID,
			{},
		);
		expect(result.status).toBe("verified");
		expect(h.receipt?.mediaSha256).toBe(largeRecord.sha256);
		expect(
			h.env.RECOVERY_STORAGE.put.mock.calls.find((call) =>
				(call[0] as string).startsWith(CMS_SITE_DRILL_PREFIX + "media/"),
			)?.[1],
		).toBeInstanceOf(ReadableStream);
		vi.unstubAllGlobals();
	});

	it("rejects a private copy with a changed source digest", async () => {
		const h = harness(
			undefined,
			false,
			undefined,
			undefined,
			new Uint8Array([4, 5, 6]),
		);
		await expect(
			readSiteDrillCapture(h.env.RECOVERY_STORAGE as never),
		).rejects.toThrow("source copy digest mismatch");
		expect(
			h.env.RECOVERY_STORAGE.put.mock.calls.some(
				(call) => call[0] === `${CMS_SITE_DRILL_PREFIX}manifest.json`,
			),
		).toBe(false);
	});

	it("rejects a private copy whose stored bytes changed", async () => {
		const h = harness(undefined, false, undefined, undefined, bytes, true);
		await expect(
			readSiteDrillCapture(h.env.RECOVERY_STORAGE as never),
		).rejects.toThrow("copied backup digest mismatch");
		expect(
			h.env.RECOVERY_STORAGE.put.mock.calls.some(
				(call) => call[0] === `${CMS_SITE_DRILL_PREFIX}manifest.json`,
			),
		).toBe(false);
	});

	it("aborts the source pipe when private R2 rejects before reading", async () => {
		const h = harness(
			undefined,
			false,
			undefined,
			undefined,
			bytes,
			false,
			true,
		);
		await expect(
			readSiteDrillCapture(h.env.RECOVERY_STORAGE as never),
		).rejects.toThrow("private R2 put rejected");
		expect(
			h.env.RECOVERY_STORAGE.put.mock.calls.some(
				(call) => call[0] === `${CMS_SITE_DRILL_PREFIX}manifest.json`,
			),
		).toBe(false);
	});

	it("rejects arbitrary instance ids and payloads before a mutation", async () => {
		const h = harness();
		await expect(
			runCmsSiteRestoreDrill(h.env as never, h.step as never, "other", {}),
		).rejects.toThrow("fixed Workflow instance ID");
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{ siteId: CMS_SITE_DRILL_SITE_ID },
			),
		).rejects.toThrow("empty parameters");
		expect(h.step.do).not.toHaveBeenCalled();
	});

	it("claims a stable SQLite baseline even when its current bookmark differs", async () => {
		const h = harness();
		h.setBookmark("different-bookmark");
		wireMedia(h);
		const result = await runCmsSiteRestoreDrill(
			h.env as never,
			h.step as never,
			CMS_SITE_DRILL_INSTANCE_ID,
			{},
		);
		expect(result.status).toBe("verified");
		expect(h.receipt?.databaseDigest).toBe(CMS_SITE_DRILL_BASELINE_DIGEST);
		expect(h.receipt?.schedulerHeartbeatRevision).toBe("frozen-revision");
		vi.unstubAllGlobals();
	});

	it("rejects SQLite drift before claiming the fixed site", async () => {
		const h = harness();
		h.setDatabaseDigest("b".repeat(64));
		wireMedia(h);
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("database drifted from capture");
		expect(h.receipt).toBeNull();
		expect(h.sentinel).toBe("absent");
		vi.unstubAllGlobals();
	});

	it("rejects full SQLite drift after the sentinel mutation", async () => {
		const h = harness(undefined, false, undefined, "b".repeat(64));
		wireMedia(h);
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("database proof mismatch");
		expect(h.receipt?.phase).toBe("mutated");
		expect(h.mediaPresent).toBe(true);
		vi.unstubAllGlobals();
	});

	it("restores, undoes, and returns the actual site to its captured baseline", async () => {
		const h = harness();
		dependencies.assertSourceMediaMatches
			.mockReset()
			.mockImplementation(async ({ missingKey }: { missingKey?: string }) => {
				if (h.mediaPresent === Boolean(missingKey))
					throw new Error("media parity mismatch");
			});
		dependencies.deleteSourceMediaObject
			.mockReset()
			.mockImplementation(async () => {
				h.setMediaPresent(false);
				h.events.push("media-deleted");
			});
		dependencies.restoreSourceMediaObject
			.mockReset()
			.mockImplementation(async () => {
				h.setMediaPresent(true);
				h.events.push("media-restored");
			});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("/posts/")
					? new Response("Native taxonomy archive proof")
					: h.mediaPresent
						? new Response(bytes, { status: 200 })
						: new Response("missing", { status: 404 }),
			),
		);
		const result = await runCmsSiteRestoreDrill(
			h.env as never,
			h.step as never,
			CMS_SITE_DRILL_INSTANCE_ID,
			{},
		);
		expect(result).toEqual({ status: "verified", evidence: "fresh" });
		expect(h.receipt?.phase).toBe("verified");
		expect(h.sentinel).toBe("absent");
		expect(h.mediaPresent).toBe(true);
		expect(h.events.indexOf("media-deleted")).toBeLessThan(
			h.events.indexOf("restore-scheduled"),
		);
		expect(h.stub.restartSiteDrill).toHaveBeenCalledTimes(3);
		expect(h.env.DB_DO.idFromName).toHaveBeenCalledWith(CMS_SITE_DRILL_SLUG);
		vi.unstubAllGlobals();
	});

	it("compensates media when scheduling fails after deletion", async () => {
		const h = harness("schedule-fixed-site-restore");
		dependencies.assertSourceMediaMatches
			.mockReset()
			.mockImplementation(async ({ missingKey }: { missingKey?: string }) => {
				if (h.mediaPresent === Boolean(missingKey))
					throw new Error("media parity mismatch");
			});
		dependencies.deleteSourceMediaObject
			.mockReset()
			.mockImplementation(async () => {
				h.setMediaPresent(false);
			});
		dependencies.restoreSourceMediaObject
			.mockReset()
			.mockImplementation(async () => {
				h.setMediaPresent(true);
			});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("/posts/")
					? new Response("Native taxonomy archive proof")
					: h.mediaPresent
						? new Response(bytes, { status: 200 })
						: new Response("missing", { status: 404 }),
			),
		);
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("interrupted at schedule-fixed-site-restore");
		expect(h.mediaPresent).toBe(true);
		expect(h.receipt?.phase).toBe("mutated");
		expect(h.stub.scheduleSiteDrillRestore).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("resumes a lost claim result without claiming twice", async () => {
		const h = harness(undefined, false, "preflight-and-claim-fixed-site");
		wireMedia(h);
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("lost result");
		expect(h.receipt?.phase).toBe("claimed");
		const result = await runCmsSiteRestoreDrill(
			h.env as never,
			h.step as never,
			CMS_SITE_DRILL_INSTANCE_ID,
			{},
		);
		expect(result.status).toBe("verified");
		expect(
			h.env.RECOVERY_STORAGE.put.mock.calls.filter(
				(call) => (call[2] as { onlyIf?: unknown } | undefined)?.onlyIf,
			),
		).toHaveLength(1);
		vi.unstubAllGlobals();
	});

	it("re-deletes compensated media before retrying the final restore", async () => {
		const h = harness("schedule-final-baseline-restore", true);
		wireMedia(h);
		await expect(
			runCmsSiteRestoreDrill(
				h.env as never,
				h.step as never,
				CMS_SITE_DRILL_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("interrupted at schedule-final-baseline-restore");
		expect(h.receipt?.phase).toBe("undo-scheduled");
		expect(h.mediaPresent).toBe(true);
		const result = await runCmsSiteRestoreDrill(
			h.env as never,
			h.step as never,
			CMS_SITE_DRILL_INSTANCE_ID,
			{},
		);
		expect(result.status).toBe("verified");
		expect(h.receipt?.phase).toBe("verified");
		expect(h.mediaPresent).toBe(true);
		expect(h.sentinel).toBe("absent");
		vi.unstubAllGlobals();
	});
});
