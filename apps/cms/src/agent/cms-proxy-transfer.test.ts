import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
	createSiteTransferImport,
	prepareSiteTransferExport,
} from "./cms-proxy-transfer";
import type { CmsProxyContext } from "./cms-proxy-runtime";

const args = {
	sourceSlug: "source",
	targetSlug: "target",
	exportOperationId: "export_1",
};
const encoder = new TextEncoder();
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Emdash 0.42 format v1 canonical JSON: object keys in UTF-16 order, no whitespace.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function database(owners: Record<string, string | null>): D1Database {
	return {
		prepare: () => ({
			bind: (slug: string) => ({
				first: async () =>
					owners[slug] ? { organizationId: owners[slug] } : null,
			}),
		}),
	} as unknown as D1Database;
}
function context(overrides: Partial<CmsProxyContext> = {}): CmsProxyContext {
	return {
		orgSlug: "source",
		isPlatformAdmin: true,
		forwardedAuth: undefined,
		serviceApiKey: undefined,
		internalAuthToken: undefined,
		environment: "production",
		db: database({ source: "org_1", target: "org_1" }),
		loadTransferServiceKey: async (slug) => `ec_pat_${slug}`,
		cmsDispatch: {
			fetch: async () => {
				throw new Error("unexpected dispatch");
			},
		} as unknown as Fetcher,
		...overrides,
	};
}
function bytesResponse(bytes: Uint8Array, sha: string): Response {
	return new Response(new Uint8Array(bytes), {
		headers: { "Content-Length": String(bytes.byteLength), ETag: `"${sha}"` },
	});
}
function envelope(data: unknown): Response {
	return Response.json({ success: true, data });
}
function fixture(
	media: Uint8Array | { bytes: number; sha256: string } = new Uint8Array([
		0, 255, 42, 17, 128,
	]),
) {
	const record = encoder.encode(
		`${canonicalJson({ kind: "setting", id: "site:title", value: "Example" })}\n`,
	);
	const mediaSha = media instanceof Uint8Array ? digest(media) : media.sha256;
	const mediaBytes =
		media instanceof Uint8Array ? media.byteLength : media.bytes;
	const mediaPath = `media/${mediaSha}`;
	const recordPath = "records/setting/000000.ndjson";
	const entries = [
		{ path: mediaPath, bytes: mediaBytes, sha256: mediaSha },
		{
			path: recordPath,
			bytes: record.byteLength,
			sha256: digest(record),
			records: 1,
		},
	];
	const index = encoder.encode(
		entries.map((entry) => canonicalJson(entry)).join("\n") + "\n",
	);
	const manifest = encoder.encode(
		canonicalJson({
			format: "emdash-site-package",
			formatVersion: "1",
			packageId: "package_1",
			originSiteId: "site_1",
			createdAt: "2026-09-28T00:00:00.000Z",
			createdByEmDashVersion: "0.42.0",
			profile: "full-transfer",
			features: ["media", "settings"],
			requiredFeatures: ["media", "settings"],
			locales: { default: "en", used: ["en"] },
			records: { setting: { count: 1, chunks: 1 } },
			media: { count: 1, totalBytes: mediaBytes },
			files: { count: 2, totalBytes: mediaBytes + record.byteLength },
			index: [
				{
					path: "index/000000.ndjson",
					bytes: index.byteLength,
					sha256: digest(index),
					entries: 2,
				},
			],
			transformations: [],
			fence: { attempts: 1 },
		}),
	);
	const packageDigest = `sha256:${digest(manifest)}`;
	const files = new Map<string, Uint8Array>([
		["index/000000.ndjson", index],
		[recordPath, record],
	]);
	if (media instanceof Uint8Array) files.set(mediaPath, media);
	return { manifest, packageDigest, files, entries, mediaPath, recordPath };
}

describe("same-org Emdash binary transfer bridge", () => {
	it("rejects non-admin before owner lookup or PAT loading", async () => {
		let reads = 0;
		let loads = 0;
		const ctx = context({
			isPlatformAdmin: false,
			db: {
				prepare: () => {
					reads++;
					throw new Error("unexpected DB read");
				},
			} as unknown as D1Database,
			loadTransferServiceKey: async () => {
				loads++;
				return "ec_pat_secret";
			},
		});
		const response = await prepareSiteTransferExport(ctx, args);
		expect(response.isError).toBe(true);
		expect(response.content[0]?.text).toContain("Platform admin required");
		expect({ reads, loads }).toEqual({ reads: 0, loads: 0 });
	});

	it("rejects cross-org and inactive sites before PAT loading or dispatch", async () => {
		for (const target of ["other_org", null]) {
			let loads = 0;
			const ctx = context({
				db: database({ source: "org_1", target }),
				loadTransferServiceKey: async () => {
					loads++;
					return "ec_pat_secret";
				},
			});
			const response = await createSiteTransferImport(ctx, args);
			expect(response.isError).toBe(true);
			expect(response.content[0]?.text).toContain("same organization");
			expect(loads).toBe(0);
		}
	});

	it("fails closed when a target human identity is missing, misbound or a different actor", async () => {
		const identity = {
			siteId: "site-source",
			slug: "source",
			bundleEtag: "bundle",
			tenantId: "tenant",
			subject: "human-one",
			email: "editor@example.com",
			name: "Editor",
			role: 50 as const,
		};
		for (const target of [
			null,
			identity,
			{ ...identity, slug: "target", subject: "other" },
		]) {
			const response = await prepareSiteTransferExport(
				context({
					humanAuthRequired: true,
					humanIdentity: identity,
					internalAuthToken: "trusted",
					loadTransferHumanIdentity: async (slug) =>
						slug === "source" ? identity : target,
				}),
				args,
			);
			expect(response.isError).toBe(true);
			expect(response.content[0]?.text).toContain(
				"Verified human transfer identities required",
			);
		}
	});

	it.each([false, true])(
		"copies an official manifest and files with human=%s",
		async (human) => {
			const pkg = fixture();
			const calls: string[] = [];
			const uploads: string[] = [];
			const keys: string[] = [];
			let indexUploaded = false;
			const identity = (slug: string) => ({
				siteId: `site-${slug}`,
				slug,
				bundleEtag: `bundle-${slug}`,
				tenantId: "tenant",
				subject: "human-one",
				email: "editor@example.com",
				name: "Editor",
				role: 50 as const,
			});
			const ctx = context({
				...(human
					? {
							humanAuthRequired: true,
							humanIdentity: identity("source"),
							internalAuthToken: "trusted",
							loadTransferHumanIdentity: async (slug: string) => identity(slug),
							loadTransferServiceKey: async () => {
								throw new Error("Human must not load PAT");
							},
						}
					: {}),
				cmsDispatch: {
					fetch: async (request: Request) => {
						const url = new URL(request.url);
						const path = url.pathname;
						const source = url.hostname.startsWith("source.");
						calls.push(`${request.method} ${path}`);
						if (human) {
							expect(request.headers.has("authorization")).toBe(false);
							expect(
								request.headers.get("X-Tedix-CMS-Forwarded-User-Auth"),
							).toBe("trusted");
							const asserted = JSON.parse(
								atob(request.headers.get("X-Tedix-CMS-Human-Identity")!),
							);
							expect(asserted.slug).toBe(source ? "source" : "target");
							expect(asserted.subject).toBe("human-one");
						} else {
							expect(request.headers.get("authorization")).toBe(
								`Bearer ec_pat_${source ? "source" : "target"}`,
							);
						}
						if (source && path.endsWith("/exports/export_1"))
							return envelope({
								operation: {
									state: "complete",
									packageDigest: pkg.packageDigest,
								},
							});
						if (source && path.endsWith("/manifest"))
							return bytesResponse(pkg.manifest, digest(pkg.manifest));
						if (source && path.includes("/files/")) {
							const file = pkg.files.get(path.split("/files/")[1]!);
							if (!file) throw new Error("unexpected source path");
							return bytesResponse(file, digest(file));
						}
						if (
							!source &&
							request.method === "POST" &&
							path.endsWith("/imports")
						) {
							keys.push(request.headers.get("Idempotency-Key") ?? "");
							expect(new Uint8Array(await request.arrayBuffer())).toEqual(
								pkg.manifest,
							);
							return envelope({ operation: { id: "import_1" }, created: true });
						}
						if (!source && path.endsWith("/imports/import_1"))
							return envelope({
								operation: {
									state: "uploading",
									packageDigest: pkg.packageDigest,
								},
							});
						if (!source && path.endsWith("/missing"))
							return envelope({
								items: indexUploaded
									? pkg.entries
									: [
											{
												path: "index/000000.ndjson",
												bytes: pkg.files.get("index/000000.ndjson")!.byteLength,
												sha256: digest(pkg.files.get("index/000000.ndjson")!),
											},
										],
							});
						if (!source && request.method === "PUT") {
							const filePath = path.split("/files/")[1]!;
							expect(new Uint8Array(await request.arrayBuffer())).toEqual(
								pkg.files.get(filePath),
							);
							uploads.push(filePath);
							if (filePath === "index/000000.ndjson") indexUploaded = true;
							return envelope({
								path: filePath,
								bytes: pkg.files.get(filePath)!.byteLength,
							});
						}
						throw new Error("unexpected request");
					},
				} as Fetcher,
			});
			const first = await createSiteTransferImport(ctx, args);
			expect(first.isError).toBeUndefined();
			expect(JSON.parse(first.content[0]!.text)).toMatchObject({
				importOperationId: "import_1",
				copied: ["index/000000.ndjson"],
				phase: "uploading",
			});
			const second = await createSiteTransferImport(ctx, {
				...args,
				importOperationId: "import_1",
			});
			expect(second.isError).toBeUndefined();
			expect(JSON.parse(second.content[0]!.text).copied).toEqual([
				pkg.mediaPath,
				pkg.recordPath,
			]);
			expect(uploads).toEqual([
				"index/000000.ndjson",
				pkg.mediaPath,
				pkg.recordPath,
			]);
			expect(keys).toHaveLength(1);
			expect(keys[0]).toMatch(/^tedix-[0-9a-f]{64}$/);
			expect(calls.some((call) => /analyze|execute/.test(call))).toBe(false);
		},
	);

	it("uses the same idempotency key after an ambiguous import-create response", async () => {
		const pkg = fixture();
		const keys: string[] = [];
		let posts = 0;
		const ctx = context({
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (path.endsWith("/exports/export_1"))
						return envelope({
							operation: {
								state: "complete",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/manifest"))
						return bytesResponse(pkg.manifest, digest(pkg.manifest));
					if (request.method === "POST") {
						keys.push(request.headers.get("Idempotency-Key") ?? "");
						posts++;
						if (posts === 1)
							throw new Error("response lost after upstream creation");
						return envelope({ operation: { id: "import_1" }, created: false });
					}
					if (path.endsWith("/imports/import_1"))
						return envelope({
							operation: {
								state: "uploading",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/missing")) return envelope({ items: [] });
					throw new Error("unexpected request");
				},
			} as Fetcher,
		});
		const first = await createSiteTransferImport(ctx, args);
		expect(first.isError).toBe(true);
		const second = await createSiteTransferImport(ctx, args);
		expect(second.isError).toBeUndefined();
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
		expect(JSON.parse(second.content[0]!.text)).toMatchObject({
			importOperationId: "import_1",
			created: false,
		});
	});

	it("rejects a source file with a mismatched ETag before target upload", async () => {
		const pkg = fixture();
		let uploads = 0;
		const ctx = context({
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (request.method === "PUT") uploads++;
					if (path.endsWith("/exports/export_1"))
						return envelope({
							operation: {
								state: "complete",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/manifest"))
						return bytesResponse(pkg.manifest, digest(pkg.manifest));
					if (request.method === "POST")
						return envelope({ operation: { id: "import_1" }, created: true });
					if (path.endsWith("/imports/import_1"))
						return envelope({
							operation: {
								state: "uploading",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/missing"))
						return envelope({
							items: [
								{
									path: "index/000000.ndjson",
									bytes: pkg.files.get("index/000000.ndjson")!.byteLength,
									sha256: digest(pkg.files.get("index/000000.ndjson")!),
								},
							],
						});
					if (path.endsWith("/files/index/000000.ndjson"))
						return bytesResponse(
							pkg.files.get("index/000000.ndjson")!,
							"0".repeat(64),
						);
					throw new Error("unexpected request");
				},
			} as Fetcher,
		});
		const response = await createSiteTransferImport(ctx, args);
		expect(response.isError).toBe(true);
		expect(response.content[0]?.text).toContain("ETag mismatch");
		expect(uploads).toBe(0);
	});

	it("rejects unknown record kinds before fetching their bytes", async () => {
		const pkg = fixture();
		let fetched = false;
		const ctx = context({
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (path.endsWith("/exports/export_1"))
						return envelope({
							operation: {
								state: "complete",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/manifest"))
						return bytesResponse(pkg.manifest, digest(pkg.manifest));
					if (path.endsWith("/imports/import_1"))
						return envelope({
							operation: {
								state: "uploading",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/missing"))
						return envelope({
							items: [
								{
									path: "records/not_a_kind/000000.ndjson",
									bytes: 1,
									sha256: "0".repeat(64),
								},
							],
						});
					if (path.includes("/files/")) fetched = true;
					throw new Error("unexpected request");
				},
			} as Fetcher,
		});
		const response = await createSiteTransferImport(ctx, {
			...args,
			importOperationId: "import_1",
		});
		expect(response.isError).toBe(true);
		expect(fetched).toBe(false);
	});

	it("rejects truncated, oversized, and corrupt source streams before confirming an upload", async () => {
		const media = new Uint8Array([1, 2, 3, 4, 5]);
		const pkg = fixture(media);
		for (const actual of [
			media.subarray(0, 4),
			new Uint8Array([1, 2, 3, 4, 5, 6]),
			new Uint8Array([1, 2, 3, 4, 9]),
		]) {
			let confirmed = false;
			const ctx = context({
				cmsDispatch: {
					fetch: async (request: Request) => {
						const path = new URL(request.url).pathname;
						if (path.endsWith("/exports/export_1"))
							return envelope({
								operation: {
									state: "complete",
									packageDigest: pkg.packageDigest,
								},
							});
						if (path.endsWith("/manifest"))
							return bytesResponse(pkg.manifest, digest(pkg.manifest));
						if (path.endsWith("/imports/import_1"))
							return envelope({
								operation: {
									state: "uploading",
									packageDigest: pkg.packageDigest,
								},
							});
						if (path.endsWith("/missing"))
							return envelope({
								items: [
									{
										path: pkg.mediaPath,
										bytes: media.byteLength,
										sha256: digest(media),
									},
								],
							});
						if (
							path.endsWith(`/files/${pkg.mediaPath}`) &&
							request.method === "GET"
						) {
							return new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(actual);
										controller.close();
									},
								}),
								{
									headers: {
										"Content-Length": String(media.byteLength),
										ETag: `"${digest(media)}"`,
									},
								},
							);
						}
						if (
							path.endsWith(`/files/${pkg.mediaPath}`) &&
							request.method === "PUT"
						) {
							try {
								const reader = request.body!.getReader();
								while (!(await reader.read()).done) {
									/* consume as Emdash would */
								}
								confirmed = true;
								return envelope({
									path: pkg.mediaPath,
									bytes: media.byteLength,
								});
							} catch {
								return Response.json({ success: false }, { status: 422 });
							}
						}
						throw new Error("unexpected request");
					},
				} as Fetcher,
			});
			const response = await createSiteTransferImport(ctx, {
				...args,
				importOperationId: "import_1",
				limit: 1,
			});
			expect(response.isError).toBe(true);
			expect(confirmed).toBe(false);
		}
	});

	it("copies a file near the declared 50 MiB ceiling without chunk accumulation", async () => {
		const mediaBytes = MAX_FILE_BYTES - 1;
		const chunk = new Uint8Array(1024 * 1024);
		chunk[0] = 255;
		chunk[chunk.length - 1] = 17;
		const hasher = createHash("sha256");
		for (let offset = 0; offset < mediaBytes; offset += chunk.length)
			hasher.update(
				chunk.subarray(0, Math.min(chunk.length, mediaBytes - offset)),
			);
		const mediaSha = hasher.digest("hex");
		const pkg = fixture({ bytes: mediaBytes, sha256: mediaSha });
		let uploadLength = 0;
		const ctx = context({
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (path.endsWith("/exports/export_1"))
						return envelope({
							operation: {
								state: "complete",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/manifest"))
						return bytesResponse(pkg.manifest, digest(pkg.manifest));
					if (path.endsWith("/imports/import_1"))
						return envelope({
							operation: {
								state: "uploading",
								packageDigest: pkg.packageDigest,
							},
						});
					if (path.endsWith("/missing"))
						return envelope({
							items: [
								{
									path: pkg.mediaPath,
									bytes: mediaBytes,
									sha256: mediaSha,
								},
							],
						});
					if (
						path.endsWith(`/files/${pkg.mediaPath}`) &&
						request.method === "GET"
					) {
						let offset = 0;
						return new Response(
							new ReadableStream({
								pull(controller) {
									if (offset >= mediaBytes) {
										controller.close();
										return;
									}
									const length = Math.min(chunk.length, mediaBytes - offset);
									controller.enqueue(chunk.subarray(0, length));
									offset += length;
								},
							}),
							{
								headers: {
									"Content-Length": String(mediaBytes),
									ETag: `"${mediaSha}"`,
								},
							},
						);
					}
					if (
						path.endsWith(`/files/${pkg.mediaPath}`) &&
						request.method === "PUT"
					) {
						expect(request.headers.get("Content-Length")).toBe(
							String(mediaBytes),
						);
						const reader = request.body!.getReader();
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							uploadLength += value.byteLength;
						}
						return envelope({ path: pkg.mediaPath, bytes: mediaBytes });
					}
					throw new Error("unexpected request");
				},
			} as Fetcher,
		});
		const response = await createSiteTransferImport(ctx, {
			...args,
			importOperationId: "import_1",
			limit: 1,
		});
		expect(response.isError).toBeUndefined();
		expect(uploadLength).toBe(MAX_FILE_BYTES - 1);
	});
});
