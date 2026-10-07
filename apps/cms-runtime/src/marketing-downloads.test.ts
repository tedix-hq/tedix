import { describe, expect, it } from "vite-plus/test";
import { serveCliDownload } from "./marketing-downloads";

function object(key: string, body = "payload") {
	const bytes = new TextEncoder().encode(body);
	return {
		key,
		size: bytes.byteLength,
		httpEtag: '"etag-1"',
		writeHttpMetadata(headers: Headers) {
			headers.set(
				"Content-Type",
				key.endsWith(".json") ? "application/json" : "application/octet-stream",
			);
		},
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	} as unknown as R2ObjectBody;
}

function bucket(entries: Record<string, R2ObjectBody>): R2Bucket {
	return {
		head: async (key: string) => entries[key] ?? null,
		get: async (key: string, options?: R2GetOptions) => {
			const entry = entries[key];
			if (!entry || !options?.range || options.range instanceof Headers) {
				return entry ?? null;
			}
			if (!("offset" in options.range) || !("length" in options.range)) {
				return entry;
			}
			const offset = options.range.offset ?? 0;
			const length = options.range.length ?? entry.size - offset;
			const bytes = new TextEncoder()
				.encode("payload")
				.slice(offset, offset + length);
			return {
				...entry,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
			} as unknown as R2ObjectBody;
		},
	} as unknown as R2Bucket;
}

describe("serveCliDownload", () => {
	it("ignores non-download hosts", async () => {
		const response = await serveCliDownload(
			new Request("https://tedix.dev/latest.json"),
			bucket({}),
			"downloads.tedix.dev",
		);
		expect(response).toBeNull();
	});

	it("serves immutable release objects with integrity-friendly headers", async () => {
		const key = "releases/0.1.0/tedix-0.1.0-darwin-arm64";
		const response = await serveCliDownload(
			new Request(`https://downloads.tedix.dev/${key}`),
			bucket({ [key]: object(key) }),
			"downloads.tedix.dev",
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(response?.headers.get("ETag")).toBe('"etag-1"');
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(await response?.text()).toBe("payload");
	});

	it("keeps latest metadata mutable and supports HEAD", async () => {
		const entry = object("latest.json", '{"version":"0.1.0"}');
		const response = await serveCliDownload(
			new Request("https://downloads.tedix.dev/latest.json", {
				method: "HEAD",
			}),
			bucket({ "latest.json": entry }),
			"downloads.tedix.dev",
		);
		expect(response?.headers.get("Cache-Control")).toBe(
			"public, max-age=300, must-revalidate",
		);
		expect(response?.headers.get("Content-Length")).toBe(String(entry.size));
		expect(await response?.text()).toBe("");
	});

	it("serves the beta channel pointer like the stable one", async () => {
		const entry = object("beta.json", '{"version":"0.3.0-beta.1"}');
		const response = await serveCliDownload(
			new Request("https://downloads.tedix.dev/beta.json"),
			bucket({ "beta.json": entry }),
			"downloads.tedix.dev",
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe(
			"public, max-age=300, must-revalidate",
		);
		expect(await response?.text()).toBe('{"version":"0.3.0-beta.1"}');
	});

	it("serves valid byte ranges and rejects invalid ranges", async () => {
		const key = "releases/0.1.0/tedix-0.1.0-linux-x64";
		const store = bucket({ [key]: object(key) });
		const partial = await serveCliDownload(
			new Request(`https://downloads.tedix.dev/${key}`, {
				headers: { Range: "bytes=0-3" },
			}),
			store,
			"downloads.tedix.dev",
		);
		expect(partial?.status).toBe(206);
		expect(partial?.headers.get("Content-Range")).toBe("bytes 0-3/7");
		expect(await partial?.text()).toBe("payl");

		const invalid = await serveCliDownload(
			new Request(`https://downloads.tedix.dev/${key}`, {
				headers: { Range: "bytes=99-100" },
			}),
			store,
			"downloads.tedix.dev",
		);
		expect(invalid?.status).toBe(416);
		expect(invalid?.headers.get("Content-Range")).toBe("bytes */7");
	});

	it("rejects listing, traversal, writes, and missing objects", async () => {
		const store = bucket({});
		for (const path of ["/", "/private", "/releases/../secret"]) {
			expect(
				(
					await serveCliDownload(
						new Request(`https://downloads.tedix.dev${path}`),
						store,
						"downloads.tedix.dev",
					)
				)?.status,
			).toBe(404);
		}
		expect(
			(
				await serveCliDownload(
					new Request("https://downloads.tedix.dev/latest.json", {
						method: "POST",
					}),
					store,
					"downloads.tedix.dev",
				)
			)?.status,
		).toBe(405);
	});
});
