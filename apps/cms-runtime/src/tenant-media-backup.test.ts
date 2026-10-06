import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
	assertSourceMediaMatches,
	copyAndVerifyMediaObject,
	digestSourceMediaObject,
	inventoryMedia,
	listMediaPage,
	restoreSourceMediaObject,
} from "./tenant-media-backup";

describe("private CMS media backup", () => {
	afterEach(() => vi.unstubAllGlobals());

	function recordFor(bytes: Uint8Array) {
		return {
			key: "image.png",
			size: bytes.byteLength,
			etag: "source-etag",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			contentType: "image/png",
			cacheControl: "public, max-age=60",
			contentDisposition: 'inline; filename="image.png"',
			contentEncoding: "identity",
			contentLanguage: "en",
		};
	}

	function backupFor(bytes: Uint8Array, metadata = recordFor(bytes)) {
		return {
			size: bytes.byteLength,
			etag: "backup-etag",
			httpMetadata: metadata,
			body: new Response(bytes.slice().buffer as ArrayBuffer).body,
		};
	}

	it("uses a bounded page size only when the caller requests one", async () => {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				urls.push(new URL(input));
				return Response.json({
					success: true,
					result: [],
					result_info: { is_truncated: false },
				});
			}),
		);
		const source = { accountId: "a", token: "t", slug: "site" };
		await listMediaPage(source);
		await listMediaPage({ ...source, pageSize: 10, cursor: "next" });
		expect(urls.map((url) => url.searchParams.get("per_page"))).toEqual([
			"100",
			"10",
		]);
		expect(urls[1]?.searchParams.get("cursor")).toBe("next");
		await expect(listMediaPage({ ...source, pageSize: 101 })).rejects.toThrow(
			"page size invalid",
		);
		expect(urls).toHaveLength(2);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: Array.from({ length: 11 }, (_, index) => ({
						key: `image-${index}`,
						size: 1,
						etag: "etag",
					})),
					result_info: { is_truncated: false },
				}),
			),
		);
		await expect(listMediaPage({ ...source, pageSize: 10 })).rejects.toThrow(
			"exceeded requested size",
		);
	});

	it("streams a media object larger than 1 MB and verifies all HTTP metadata", async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
		for (let index = 0; index < bytes.length; index++)
			bytes[index] = index % 251;
		const record = recordFor(bytes);
		const backup = {
			get: vi.fn(async () => backupFor(bytes)),
		};
		let stored: Uint8Array | undefined;
		let storedHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				expect(init.body).toBeInstanceOf(ReadableStream);
				stored = new Uint8Array(await new Response(init.body).arrayBuffer());
				storedHeaders = new Headers(init.headers);
				return new Response(null, { status: 200 });
			}
			return new Response(stored ? (stored.buffer as ArrayBuffer) : null, {
				headers: storedHeaders,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		await restoreSourceMediaObject({
			accountId: "a",
			token: "t",
			slug: "site",
			record,
			backup: backup as unknown as R2Bucket,
			backupKey: "private/media/image.png",
		});
		expect(backup.get).toHaveBeenCalledTimes(2);
		expect(stored).toEqual(bytes);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [name, value] of [
			["content-type", record.contentType],
			["cache-control", record.cacheControl],
			["content-disposition", record.contentDisposition],
			["content-encoding", record.contentEncoding],
			["content-language", record.contentLanguage],
		] as const)
			expect(storedHeaders?.get(name)).toBe(value);
	});

	it("rejects a changed backup between verification and upload", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const backup = {
			get: vi
				.fn()
				.mockResolvedValueOnce(backupFor(bytes))
				.mockResolvedValueOnce({ ...backupFor(bytes), etag: "replacement" }),
		};
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			restoreSourceMediaObject({
				accountId: "a",
				token: "t",
				slug: "site",
				record: recordFor(bytes),
				backup: backup as unknown as R2Bucket,
				backupKey: "private/media/image.png",
			}),
		).rejects.toThrow("backup changed before restore");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops a streaming upload when the source rejects PUT before reading", async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024);
		const backup = { get: vi.fn(async () => backupFor(bytes)) };
		const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			restoreSourceMediaObject({
				accountId: "a",
				token: "t",
				slug: "site",
				record: recordFor(bytes),
				backup: backup as unknown as R2Bucket,
				backupKey: "private/media/image.png",
			}),
		).rejects.toThrow("media restore failed: 503");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("reports a lost PUT response and lets the caller verify the committed object", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const record = recordFor(bytes);
		const backup = { get: vi.fn(async () => backupFor(bytes)) };
		let stored = false;
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				await new Response(init.body).arrayBuffer();
				stored = true;
				throw new Error("connection lost after commit");
			}
			if (String(_url).endsWith("/objects?per_page=100"))
				return Response.json({
					success: true,
					result: [{ key: record.key, size: record.size, etag: "restored" }],
				});
			return new Response(stored ? bytes : null, {
				status: stored ? 200 : 404,
				headers: {
					"Content-Type": record.contentType,
					"Cache-Control": record.cacheControl,
					"Content-Disposition": record.contentDisposition,
					"Content-Encoding": record.contentEncoding,
					"Content-Language": record.contentLanguage,
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			restoreSourceMediaObject({
				accountId: "a",
				token: "t",
				slug: "site",
				record,
				backup: backup as unknown as R2Bucket,
				backupKey: "private/media/image.png",
			}),
		).rejects.toThrow("connection lost after commit");
		await expect(
			assertSourceMediaMatches({
				accountId: "a",
				token: "t",
				slug: "site",
				records: [record],
			}),
		).resolves.toBeUndefined();
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
		).toHaveLength(1);
	});

	it("rejects a restored object with changed HTTP metadata", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const record = recordFor(bytes);
		const backup = { get: vi.fn(async () => backupFor(bytes)) };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				if (init?.method === "PUT") {
					await new Response(init.body).arrayBuffer();
					return new Response(null, { status: 200 });
				}
				return new Response(bytes, {
					headers: {
						"Content-Type": record.contentType,
						"Cache-Control": "private",
						"Content-Disposition": record.contentDisposition,
						"Content-Encoding": record.contentEncoding,
						"Content-Language": record.contentLanguage,
					},
				});
			}),
		);
		await expect(
			restoreSourceMediaObject({
				accountId: "a",
				token: "t",
				slug: "site",
				record,
				backup: backup as unknown as R2Bucket,
				backupKey: "private/media/image.png",
			}),
		).rejects.toThrow("restored media metadata mismatch");
	});

	it("rejects duplicate source keys across inventory pages", async () => {
		let call = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [{ key: "image.png", size: 3, etag: "one" }],
					result_info:
						call++ === 0
							? { is_truncated: true, cursor: "next" }
							: { is_truncated: false },
				}),
			),
		);
		await expect(
			inventoryMedia({ accountId: "a", token: "t", slug: "site" }),
		).rejects.toThrow("duplicate keys");
		vi.unstubAllGlobals();
	});

	it("rejects a source byte change after a verified copy", async () => {
		const original = new Uint8Array([1, 2, 3]);
		const changed = new Uint8Array([1, 2, 4]);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(original, {
						headers: {
							"Content-Type": "image/png",
							"Cache-Control": "public, max-age=60",
						},
					}),
			),
		);
		let stored: Uint8Array | undefined;
		const destination = {
			put: vi.fn(async (_key: string, stream: ReadableStream<Uint8Array>) => {
				stored = new Uint8Array(await new Response(stream).arrayBuffer());
				return { size: stored.byteLength };
			}),
			get: vi.fn(async () => ({
				size: stored?.byteLength,
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(stored!);
						controller.close();
					},
				}),
			})),
		};
		const result = await copyAndVerifyMediaObject({
			accountId: "a",
			token: "t",
			slug: "site",
			object: { key: "image.png", size: 3, etag: "one" },
			destination: destination as unknown as R2Bucket,
			destinationKey: "recovery/site/capture/media/image.png",
		});
		expect(result.contentType).toBe("image/png");
		expect(destination.put).toHaveBeenCalledOnce();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(changed)),
		);
		const reread = await digestSourceMediaObject({
			accountId: "a",
			token: "t",
			slug: "site",
			key: "image.png",
		});
		expect(reread.sha256).not.toBe(result.sha256);
		vi.unstubAllGlobals();
	});

	it("rejects a repeated cursor during full source parity", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					success: true,
					result: [{ key: "image.png", size: 3, etag: "one" }],
					result_info: { is_truncated: true, cursor: "same" },
				}),
			),
		);
		await expect(
			assertSourceMediaMatches({
				accountId: "a",
				token: "t",
				slug: "site",
				records: [],
			}),
		).rejects.toThrow("cursor did not advance");
		vi.unstubAllGlobals();
	});

	it("does not PUT a corrupt private backup over source media", async () => {
		const original = new Uint8Array([1, 2, 3]);
		const changed = new Uint8Array([1, 2, 4]);
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const backup = {
			get: vi.fn(async () => backupFor(changed, recordFor(original))),
		};
		await expect(
			restoreSourceMediaObject({
				accountId: "a",
				token: "t",
				slug: "site",
				record: recordFor(original),
				backup: backup as unknown as R2Bucket,
				backupKey: "private/media/image.png",
			}),
		).rejects.toThrow("backup object digest mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
