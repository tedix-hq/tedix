import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { R2Storage } from "@emdash-cms/cloudflare/storage/r2";

import { TenantR2 } from "./index";

const props = {
	accountId: "account",
	bucketName: "tenant-media",
	token: "private-token",
	siteId: "site-1",
	slug: "tenant",
};

function acceptingPermitD1(): D1Database {
	return {
		prepare: () => ({
			bind: () => ({ all: async () => ({ results: [{ id: "permit" }] }) }),
		}),
	} as unknown as D1Database;
}

function tenantR2(): TenantR2 {
	const entrypoint = Object.create(TenantR2.prototype) as TenantR2;
	Object.defineProperty(entrypoint, "ctx", { value: { props } });
	Object.defineProperty(entrypoint, "env", {
		value: { PLATFORM_DB: acceptingPermitD1() },
	});
	return entrypoint;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("tenant R2 transfer storage contract", () => {
	test("returns an unconsumed stream with its size and HTTP metadata", async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[pulls++];
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const fetch = vi.fn().mockResolvedValue(
			new Response(body, {
				headers: {
					"Content-Length": "5",
					"Content-Type": "image/webp",
					"Cache-Control": "public, max-age=60",
					ETag: '"hash"',
				},
			}),
		);
		vi.stubGlobal("fetch", fetch);

		const object = await tenantR2().get("media/photo.webp");

		expect(object).toMatchObject({
			size: 5,
			httpEtag: '"hash"',
			httpMetadata: {
				contentType: "image/webp",
				cacheControl: "public, max-age=60",
			},
		});
		expect(object?.body).toBeInstanceOf(ReadableStream);
		expect(
			new Uint8Array(await new Response(object?.body).arrayBuffer()),
		).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toContain("media%2Fphoto.webp");
		expect(fetch.mock.calls[0]?.[1]?.headers.Authorization).toBe(
			"Bearer private-token",
		);
	});

	test("streams uploads and returns the stored size from R2", async () => {
		let written: Uint8Array | undefined;
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			if (init.method === "PUT") {
				written = new Uint8Array(await new Response(init.body).arrayBuffer());
				return new Response(null, { status: 200, headers: { ETag: '"put"' } });
			}
			return Response.json({
				result: [
					{
						key: "media/photo.webp",
						size: written?.byteLength,
						etag: "stored",
					},
				],
			});
		});
		vi.stubGlobal("fetch", fetch);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4, 5]));
				controller.close();
			},
		});

		const storage = new R2Storage(tenantR2() as unknown as R2Bucket);
		const result = await storage.upload({
			key: "media/photo.webp",
			body,
			contentType: "image/webp",
			cacheControl: "public, max-age=60",
		});

		expect(written).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		expect(result).toEqual({
			key: "media/photo.webp",
			url: "/_emdash/api/media/file/media/photo.webp",
			size: 5,
		});
		expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual([
			"PUT",
			undefined,
		]);
		expect(new URL(fetch.mock.calls[1]![0]).searchParams.get("prefix")).toBe(
			"media/photo.webp",
		);
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer private-token",
			"Content-Type": "image/webp",
			"Cache-Control": "public, max-age=60",
		});
	});

	test("feeds the upstream Emdash R2 download adapter", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(new Uint8Array([9, 8, 7]), {
					headers: {
						"Content-Length": "3",
						"Content-Type": "application/octet-stream",
					},
				}),
			),
		);
		const storage = new R2Storage(tenantR2() as unknown as R2Bucket);

		const downloaded = await storage.download("transfer/blob");

		expect(downloaded.size).toBe(3);
		expect(downloaded.contentType).toBe("application/octet-stream");
		expect(
			new Uint8Array(await new Response(downloaded.body).arrayBuffer()),
		).toEqual(new Uint8Array([9, 8, 7]));
	});

	test("uses exact object-list metadata when an R2 read omits Content-Length", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(new Uint8Array([9, 8, 7]), {
					headers: { "Content-Type": "application/octet-stream" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					result: [{ key: "transfer/blob", size: 3, etag: "stored" }],
				}),
			);
		vi.stubGlobal("fetch", fetch);

		const object = await tenantR2().get("transfer/blob");

		expect(object?.size).toBe(3);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(new URL(fetch.mock.calls[1]![0]).searchParams.get("prefix")).toBe(
			"transfer/blob",
		);
		expect(fetch.mock.calls[1]?.[1]?.method).toBeUndefined();
	});

	test("does not accept another object sharing a key prefix as metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					result: [{ key: "transfer/blob-extra", size: 4, etag: "other" }],
				}),
			),
		);
		expect(await tenantR2().head("transfer/blob")).toBeNull();
	});

	test("preserves missing-object behavior", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);
		expect(await tenantR2().get("missing")).toBeNull();
	});
});
