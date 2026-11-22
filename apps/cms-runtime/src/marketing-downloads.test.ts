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
		json: async () => JSON.parse(body),
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

	it("redirects the stable desktop links to the release latest.json names", async () => {
		const files = bucket({
			"desktop/latest.json": object(
				"desktop/latest.json",
				JSON.stringify({ schemaVersion: 1, version: "0.1.33" }),
			),
			"desktop/releases/0.1.33/Tedix-0.1.33-darwin-arm64.zip": object(
				"desktop/releases/0.1.33/Tedix-0.1.33-darwin-arm64.zip",
			),
			"desktop/releases/0.1.33/Tedix-0.1.33-darwin-x64.zip": object(
				"desktop/releases/0.1.33/Tedix-0.1.33-darwin-x64.zip",
			),
		});
		for (const arch of ["arm64", "x64"]) {
			const response = await serveCliDownload(
				new Request(
					`https://downloads.tedix.dev/desktop/latest/Tedix-darwin-${arch}.zip`,
				),
				files,
				"downloads.tedix.dev",
			);
			expect(response?.status).toBe(302);
			expect(response?.headers.get("Location")).toBe(
				`https://downloads.tedix.dev/desktop/releases/0.1.33/Tedix-0.1.33-darwin-${arch}.zip`,
			);
			expect(response?.headers.get("Cache-Control")).toBe("no-store");
		}
	});

	it("answers 404 for a stable desktop link without a valid published release", async () => {
		const request = () =>
			new Request(
				"https://downloads.tedix.dev/desktop/latest/Tedix-darwin-arm64.zip",
			);
		const pointer = (version: string) => ({
			"desktop/latest.json": object(
				"desktop/latest.json",
				JSON.stringify({ version }),
			),
		});
		for (const entries of [{}, pointer("../0.1.33"), pointer("0.1.33")]) {
			const response = await serveCliDownload(
				request(),
				bucket(entries),
				"downloads.tedix.dev",
			);
			expect(response?.status).toBe(404);
		}
		const other = await serveCliDownload(
			new Request(
				"https://downloads.tedix.dev/desktop/latest/Tedix-linux-x64.zip",
			),
			bucket(pointer("0.1.33")),
			"downloads.tedix.dev",
		);
		expect(other?.status).toBe(404);
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
