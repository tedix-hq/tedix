import { beforeEach, describe, expect, it } from "vite-plus/test";
import { callSandboxFreeCmsProxyTool } from "./cms-proxy";
import { mediaToFieldValue, mediaUpload } from "./cms-proxy-media";
import { buildCmsAuthHeaderCandidates, isJwt } from "./cms-proxy-auth";
import { type CmsProxyContext } from "./cms-proxy-runtime";
import { callCmsRest } from "./cms-proxy-rest";
import { callTenantMcpTool, clearTenantMcpEras } from "./cms-proxy-tenant-mcp";
import { registerCmsProxyTools } from "./cms-proxy-tools";

import {
	baseContext,
	buildCmsAuthHeaders,
	emdashMcpHandshake,
	EMDASH_HANDSHAKE,
} from "./__tests__/cms-proxy-fixtures";

// Each test starts without a remembered tenant MCP era, so the first native
// call pays the discover probe exactly as a cold isolate does.
beforeEach(() => clearTenantMcpEras());

describe("isJwt", () => {
	it("accepts a compact JWT shape", () => {
		expect(isJwt("aaa.bbb.ccc")).toBe(true);
	});

	it("rejects Emdash token formats", () => {
		expect(isJwt("ec_pat_secret")).toBe(false);
		expect(isJwt("ec_oat_secret")).toBe(false);
	});
});

describe("versioned block schema proxy", () => {
	const blockField = { slug: "heading", label: "Heading", type: "string" };
	const blockType = {
		id: "block_1",
		slug: "hero",
		label: "Hero",
		currentVersion: 1,
		source: "user",
		versions: [
			{
				id: "version_1",
				blockTypeId: "block_1",
				version: 1,
				fields: [blockField],
				fingerprint: "fingerprint_1",
				active: true,
				createdAt: "2026-09-26T00:00:00Z",
				updatedAt: "2026-09-26T00:00:00Z",
			},
		],
		createdAt: "2026-09-26T00:00:00Z",
		updatedAt: "2026-09-26T00:00:00Z",
	};

	it("advertises five block tools and validates their versioned contracts", () => {
		type ToolDefinition = {
			inputSchema: { safeParse(value: unknown): { success: boolean } };
			outputSchema?: { safeParse(value: unknown): { success: boolean } };
			annotations?: { readOnlyHint?: boolean };
		};
		const tools = new Map<string, ToolDefinition>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: ToolDefinition) => {
					tools.set(name, definition);
				},
			} as any,
			baseContext,
		);

		for (const name of [
			"schema_list_block_types",
			"schema_get_block_type",
			"schema_create_block_type",
			"schema_update_block_type",
			"schema_activate_block_type_version",
		])
			expect(tools.get(name), name).toBeDefined();
		expect(
			tools.get("schema_list_block_types")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(tools.get("schema_get_block_type")?.annotations?.readOnlyHint).toBe(
			true,
		);
		expect(
			tools.get("schema_list_block_types")?.outputSchema?.safeParse({
				success: true,
				data: { items: [blockType] },
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_get_block_type")?.outputSchema?.safeParse({
				success: true,
				data: { item: blockType },
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "hero",
				label: "Hero",
				fields: [blockField],
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "Bad Slug",
				label: "Hero",
				fields: [blockField],
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "hero",
				label: "Hero",
				fields: [{ ...blockField, type: "reference" }],
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_update_block_type")?.inputSchema.safeParse({
				slug: "hero",
				expectedFingerprint: "",
				breaking: true,
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_activate_block_type_version")?.inputSchema.safeParse({
				slug: "hero",
				version: 0,
				expectedFingerprint: "fingerprint_1",
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_activate_block_type_version")?.inputSchema.safeParse({
				slug: "hero",
				version: 2,
				expectedFingerprint: "fingerprint_1",
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_field")?.inputSchema.safeParse({
				collection: "pages",
				slug: "sections",
				label: "Sections",
				type: "blocks",
				validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
			}).success,
		).toBe(true);
	});

	it("maps all five tools to Emdash REST with human JWT attribution", async () => {
		const requests: Array<{
			method: string;
			path: string;
			body: unknown;
			cookie: string | null;
			authorization: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body: request.body ? await request.json() : undefined,
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
					});
					return Response.json({
						success: true,
						data:
							request.method === "GET" &&
							new URL(request.url).pathname.endsWith("/block-types")
								? { items: [blockType] }
								: { item: blockType },
					});
				},
			} as Fetcher,
		};
		const cases = [
			[
				"schema_list_block_types",
				{},
				"GET",
				"/_emdash/api/schema/block-types",
				undefined,
			],
			[
				"schema_get_block_type",
				{ slug: "hero" },
				"GET",
				"/_emdash/api/schema/block-types/hero",
				undefined,
			],
			[
				"schema_create_block_type",
				{ slug: "hero", label: "Hero", fields: [blockField] },
				"POST",
				"/_emdash/api/schema/block-types",
				{ slug: "hero", label: "Hero", fields: [blockField] },
			],
			[
				"schema_update_block_type",
				{
					slug: "hero",
					expectedFingerprint: "fingerprint_1",
					fields: [blockField],
					breaking: true,
				},
				"PUT",
				"/_emdash/api/schema/block-types/hero",
				{
					expectedFingerprint: "fingerprint_1",
					fields: [blockField],
					breaking: true,
				},
			],
			[
				"schema_activate_block_type_version",
				{ slug: "hero", version: 2, expectedFingerprint: "fingerprint_1" },
				"POST",
				"/_emdash/api/schema/block-types/hero/versions/2/activate",
				{ expectedFingerprint: "fingerprint_1" },
			],
		] as const;
		for (const [name, args, method, path, body] of cases) {
			const result = await callCmsRest(ctx, name, args);
			expect(result.isError, name).toBeUndefined();
			expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
				success: true,
				data:
					name === "schema_list_block_types"
						? { items: [blockType] }
						: { item: blockType },
			});
			expect(requests.at(-1)).toEqual({
				method,
				path,
				body,
				cookie: "DS=aaa.bbb.ccc",
				authorization: null,
			});
		}
		expect(requests).toHaveLength(cases.length);
	});

	it("passes blocks field allowlists to the collection schema route", async () => {
		let sent: unknown;
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/schema/collections/pages/fields",
					);
					sent = await request.json();
					return Response.json({
						success: true,
						data: { item: { slug: "sections" } },
					});
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "schema_create_field", {
			collection: "pages",
			slug: "sections",
			label: "Sections",
			type: "blocks",
			validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
		});
		expect(result.isError).toBeUndefined();
		expect(sent).toMatchObject({
			type: "blocks",
			validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
		});
	});

	it.each(["schema_update_block_type", "schema_activate_block_type_version"])(
		"preserves %s REST conflicts without retrying a write",
		async (name) => {
			let calls = 0;
			// The REST transport (no PAT). The native transport's conflict is
			// proven against real Emdash in tenant-mcp-emdash.test.ts.
			const ctx: CmsProxyContext = {
				...baseContext,
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: async (_request: Request) => {
						calls++;
						return Response.json(
							{
								success: false,
								error: { code: "CONFLICT", message: "Block type changed" },
							},
							{ status: 409 },
						);
					},
				} as Fetcher,
			};
			const args =
				name === "schema_update_block_type"
					? { slug: "hero", expectedFingerprint: "old" }
					: { slug: "hero", version: 2, expectedFingerprint: "old" };
			const result = await callCmsRest(ctx, name, args);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("CONFLICT");
			expect(calls).toBe(1);
		},
	);
});

describe("buildCmsAuthHeaderCandidates", () => {
	it("attests a human JWT without granting tenant internal-admin authority", () => {
		const headers =
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
			}) ?? {};
		expect(headers).toMatchObject({
			Cookie: "DS=aaa.bbb.ccc",
			"X-Tedix-CMS-Forwarded-User-Auth": "internal_secret",
		});
		expect(headers["X-Tedix-CMS-Internal-Auth"]).toBeUndefined();
	});

	it("preserves forwarded user JWTs over stored service PATs", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				forwardedAuth: "aaa.bbb.ccc",
			}),
		).toEqual({
			Accept: "application/json",
			Cookie: "DS=aaa.bbb.ccc",
			"X-EmDash-Request": "1",
		});
	});

	it("never retries a human JWT with a privileged site credential", () => {
		expect(
			buildCmsAuthHeaderCandidates({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				internalAuthToken: "internal_secret",
				forwardedAuth: "aaa.bbb.ccc",
			}).map((candidate) => candidate.source),
		).toEqual(["jwt"]);
	});

	it("lets a verified platform admin recover from a CMS cookie 401", async () => {
		const seenAuth: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			isPlatformAdmin: true,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seenAuth.push(
						request.headers.get("cookie") ??
							request.headers.get("authorization") ??
							"",
					);
					if (request.headers.has("cookie"))
						return new Response("Authentication failed", { status: 401 });
					return Response.json({ success: true, data: { taxonomies: [] } });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "taxonomy_list", {});
		expect(result.isError).toBeUndefined();
		expect(seenAuth).toEqual(["DS=aaa.bbb.ccc", "Bearer ec_pat_secret"]);
	});

	it("fails a human taxonomy delete on 403 without replaying as the site service", async () => {
		const authHeaders: Array<{
			cookie: string | null;
			authorization: string | null;
			internal: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			isPlatformAdmin: true,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					authHeaders.push({
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
						internal: request.headers.get("X-Tedix-CMS-Internal-Auth"),
					});
					return Response.json({ error: "Forbidden" }, { status: 403 });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "taxonomy_delete", {
			name: "topics",
		});
		expect(result.isError).toBe(true);
		expect(authHeaders).toEqual([
			{ cookie: "DS=aaa.bbb.ccc", authorization: null, internal: null },
		]);
	});

	it("forwards Descope JWTs as the DS cookie", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
			}),
		).toEqual({
			Accept: "application/json",
			Cookie: "DS=aaa.bbb.ccc",
			"X-EmDash-Request": "1",
		});
	});

	it("falls back to service PATs as bearer tokens", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
			}),
		).toEqual({
			Accept: "application/json",
			Authorization: "Bearer ec_pat_secret",
			"X-EmDash-Request": "1",
		});
	});

	it("does not forward platform API keys as bearer tokens", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "sk_platform_api_key",
			}),
		).toBeNull();
	});

	it("falls back to the internal Site Builder service-binding header", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "sk_platform_api_key",
				internalAuthToken: "internal_secret",
			}),
		).toEqual({
			Accept: "application/json",
			"X-Tedix-CMS-Internal-Auth": "internal_secret",
			"X-EmDash-Request": "1",
		});
	});

	it("returns null when no CMS-compatible auth is available", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "sk_platform_api_key",
			}),
		).toBeNull();
	});
});

describe("mediaToFieldValue", () => {
	it("converts the tenant MCP media_get envelope into a local MediaValue", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					expect(body.params?.name).toBe("media_get");
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										item: {
											id: "01MEDIA",
											filename: "feature.png",
											mimeType: "image/png",
											storageKey: "feature.png",
										},
									}),
								},
							],
						},
					});
				},
			} as Fetcher,
		};
		const result = await mediaToFieldValue(ctx, { mediaId: "01MEDIA" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			provider: "local",
			id: "01MEDIA",
			meta: { storageKey: "feature.png" },
		});
		expect(result).toHaveProperty("structuredContent", {
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			meta: { storageKey: "feature.png" },
		});
	});

	it("converts the native media_get envelope into a local MediaValue", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/media/01MEDIA",
					);
					return Response.json({
						success: true,
						data: {
							item: {
								id: "01MEDIA",
								filename: "feature.png",
								mimeType: "image/png",
								storageKey: "feature.png",
								width: 1024,
								height: 768,
								focalX: 0,
								focalY: 1,
								blurhash: "LTEST",
								dominantColor: "rgb(10,20,30)",
								alt: "A featured image",
								status: "ready",
							},
						},
					});
				},
			} as Fetcher,
		};
		const result = await mediaToFieldValue(ctx, { mediaId: "01MEDIA" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			focalX: 0,
			focalY: 1,
			blurhash: "LTEST",
			dominantColor: "rgb(10,20,30)",
			alt: "A featured image",
			meta: { storageKey: "feature.png" },
		});
		expect(result).toHaveProperty("structuredContent", {
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			focalX: 0,
			focalY: 1,
			blurhash: "LTEST",
			dominantColor: "rgb(10,20,30)",
			alt: "A featured image",
			meta: { storageKey: "feature.png" },
		});
	});
});

describe("mediaUpload", () => {
	it("advertises only the upstream base64 upload contract", () => {
		let uploadSchema:
			| { safeParse(input: unknown): { success: boolean } }
			| undefined;
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: { inputSchema: typeof uploadSchema },
				) => {
					if (name === "media_upload") uploadSchema = definition.inputSchema;
				},
			} as any,
			baseContext,
		);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: btoa("png"),
			}).success,
		).toBe(true);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				url: "https://cdn.example.test/cover.png",
			}).success,
		).toBe(false);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: btoa("png"),
				url: "https://cdn.example.test/cover.png",
			}).success,
		).toBe(false);
	});

	it("rejects direct URL upload calls before contacting the tenant", async () => {
		const result = await mediaUpload(baseContext, {
			filename: "remote.png",
			url: "https://cdn.example.test/remote.png",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("URL uploads are unsupported");
	});

	it("uploads through native media_upload with the service PAT and returns the stable success envelope", async () => {
		const calls: Array<{
			authorization: string | null;
			body: Record<string, any>;
			path: string;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					calls.push({
						authorization: request.headers.get("authorization"),
						body,
						path: new URL(request.url).pathname,
					});
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					if (body.params?.name === "media_upload") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify({
											item: {
												id: "media_1",
												filename: "cover.png",
												storageKey: "01J.png",
												url: "/_emdash/api/media/file/01J.png",
											},
										}),
									},
								],
							},
						});
					}
					throw new Error(`unexpected MCP method ${body.params?.name}`);
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: {
					id: "media_1",
					filename: "cover.png",
					storageKey: "01J.png",
					url: "/_emdash/api/media/file/01J.png",
				},
			},
		});
		expect(calls.map((call) => call.body.method)).toEqual([
			...EMDASH_HANDSHAKE,
			"tools/call",
		]);
		expect(calls.every((call) => call.path === "/_emdash/api/mcp")).toBe(true);
		expect(
			calls.every((call) => call.authorization === "Bearer ec_pat_secret"),
		).toBe(true);
		expect(calls[3]?.body).toMatchObject({
			method: "tools/call",
			params: {
				name: "media_upload",
				arguments: {
					filename: "cover.png",
					base64: btoa("png"),
					contentType: "image/png",
					alt: "Cover",
				},
			},
		});
	});

	it("updates stale alt and caption after native content-hash deduplication", async () => {
		const toolCalls: Array<Record<string, any>> = [];
		let storedItem: Record<string, unknown> = {
			id: "existing",
			alt: null,
			caption: null,
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					toolCalls.push(body);
					const data =
						body.params?.name === "media_upload"
							? {
									item: storedItem,
									deduplicated: true,
								}
							: {
									item: (storedItem = {
										...storedItem,
										...body.params.arguments,
									}),
								};
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify(data) }],
						},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
			caption: "Credit",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: { id: "existing", alt: "Cover", caption: "Credit" },
				deduplicated: true,
			},
		});
		expect(toolCalls.map((call) => call.params?.name)).toEqual([
			"media_upload",
			"media_update",
		]);
		expect(toolCalls[1]?.params?.arguments).toEqual({
			id: "existing",
			alt: "Cover",
			caption: "Credit",
		});

		const repeated = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
			caption: "Credit",
		});
		expect(repeated.isError).toBeUndefined();
		expect(toolCalls.map((call) => call.params?.name)).toEqual([
			"media_upload",
			"media_update",
			"media_upload",
		]);
	});

	it("reports a deduplicated alt update denied by upstream ownership rules", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result:
							body.params?.name === "media_upload"
								? {
										content: [
											{
												type: "text",
												text: JSON.stringify({
													item: { id: "existing", alt: null },
													deduplicated: true,
												}),
											},
										],
									}
								: {
										content: [{ type: "text", text: "[FORBIDDEN] Not owner" }],
										isError: true,
									},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("CMS_PARTIAL_FAILURE");
		expect(result.content[0]?.text).toContain("metadata update failed");
	});

	it("preserves caption on native base64 uploads through media_update", async () => {
		const toolCalls: Array<Record<string, any>> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					toolCalls.push(body);
					const data =
						body.params?.name === "media_upload"
							? { item: { id: "media_url", filename: "remote.png" } }
							: { item: { id: "media_url", caption: "Remote caption" } };
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify(data) }],
						},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "remote.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			caption: "Remote caption",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { item: { id: "media_url", caption: "Remote caption" } },
		});
		expect(
			toolCalls.map((call) => {
				const { _meta: _requestMeta, ...params } = call.params;
				return params;
			}),
		).toEqual([
			{
				name: "media_upload",
				arguments: {
					filename: "remote.png",
					base64: btoa("png"),
					contentType: "image/png",
				},
			},
			{
				name: "media_update",
				arguments: { id: "media_url", caption: "Remote caption" },
			},
		]);
	});

	it("falls back to the multipart REST route without a PAT and persists alt via media_update", async () => {
		const calls: Array<{
			contentType: string | null;
			filename: string | undefined;
			internalAuth: string | null;
			method: string;
			mimeType: string | undefined;
			path: string;
			text: string | undefined;
			updateBody: Record<string, unknown> | undefined;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					if (request.method === "PUT") {
						const updateBody = (await request.json()) as Record<
							string,
							unknown
						>;
						calls.push({
							contentType: request.headers.get("content-type"),
							filename: undefined,
							internalAuth: request.headers.get("x-tedix-cms-internal-auth"),
							method: request.method,
							mimeType: undefined,
							path: new URL(request.url).pathname,
							text: undefined,
							updateBody,
						});
						return Response.json({
							success: true,
							data: {
								item: { id: "media_1", filename: "cover.png", alt: "Cover" },
							},
						});
					}
					const body = await request.formData();
					const file = body.get("file");
					calls.push({
						contentType: request.headers.get("content-type"),
						filename: file instanceof File ? file.name : undefined,
						internalAuth: request.headers.get("x-tedix-cms-internal-auth"),
						method: request.method,
						mimeType: file instanceof File ? file.type : undefined,
						path: new URL(request.url).pathname,
						text: file instanceof File ? await file.text() : undefined,
						updateBody: undefined,
					});
					return Response.json({
						success: true,
						data: { item: { id: "media_1", filename: "cover.png" } },
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { item: { id: "media_1", filename: "cover.png", alt: "Cover" } },
		});
		expect(calls).toEqual([
			{
				contentType: expect.stringContaining("multipart/form-data; boundary="),
				filename: "cover.png",
				internalAuth: "internal_secret",
				method: "POST",
				mimeType: "image/png",
				path: "/_emdash/api/media",
				text: "png",
				updateBody: undefined,
			},
			{
				contentType: "application/json",
				filename: undefined,
				internalAuth: "internal_secret",
				method: "PUT",
				mimeType: undefined,
				path: "/_emdash/api/media/media_1",
				text: undefined,
				updateBody: { alt: "Cover" },
			},
		]);
	});

	it("requires base64 bytes and a MIME type", async () => {
		const result = await mediaUpload(
			{ ...baseContext, internalAuthToken: "internal_secret" },
			{ filename: "cover.png", mimeType: "image/png" },
		);

		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain(
			"dataBase64 and mimeType are required",
		);
	});

	it("rejects invalid base64 before touching the tenant runtime", async () => {
		const result = await mediaUpload(
			{ ...baseContext, internalAuthToken: "internal_secret" },
			{
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: "%%%not-base64%%%",
			},
		);

		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content[0]?.text).toContain("not valid base64");
	});

	it("does not replay a rejected human media upload with internal authority", async () => {
		const authAttempts: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "header.payload.signature",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					authAttempts.push(
						request.headers.get("cookie") ??
							request.headers.get("x-tedix-cms-internal-auth") ??
							"missing",
					);
					if (authAttempts.length === 1) {
						return new Response("Authentication failed", { status: 401 });
					}
					return Response.json({
						success: true,
						data: { item: { id: "media_internal" } },
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
		});

		expect(result.isError).toBe(true);
		expect(authAttempts).toEqual(["DS=header.payload.signature"]);
	});

	it("does not mask a non-auth upload failure with another identity", async () => {
		let attempts = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "header.payload.signature",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async () => {
					attempts += 1;
					return new Response("Unsupported media type", { status: 415 });
				},
			} as unknown as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.exe",
			mimeType: "application/octet-stream",
			dataBase64: btoa("binary"),
		});

		expect(attempts).toBe(1);
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain("415, auth=jwt");
	});

	it("fails closed when no tenant MCP bearer credential exists", async () => {
		const result = await callTenantMcpTool(
			{
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
			},
			"media_upload",
			{ filename: "cover.png", base64: btoa("png"), contentType: "image/png" },
		);

		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content[0]?.text.startsWith("[UNAUTHORIZED]")).toBe(true);
		expect(result.content[0]?.text).toContain(
			"run cms_provision_service_key first",
		);
	});
});

describe("callSandboxFreeCmsProxyTool", () => {
	it("only handles read-only operator tools", async () => {
		await expect(
			callSandboxFreeCmsProxyTool(baseContext, "theme_read_file", {}),
		).resolves.toBeNull();
	});

	it("routes content_list without a sandbox context", async () => {
		const seen: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					seen.push(`${url.pathname}?${url.searchParams.toString()}`);
					return Response.json({
						data: {
							items: [
								{
									id: "post_1",
									slug: "hello",
									status: "published",
									data: { title: "Hello" },
								},
							],
						},
					});
				},
			} as Fetcher,
		};

		const result = await callSandboxFreeCmsProxyTool(ctx, "content_list", {
			collection: "posts",
			status: "published",
			limit: 1,
		});

		expect(result?.isError).toBeUndefined();
		expect(
			JSON.parse(result?.content[0]?.text ?? "{}").data.items[0],
		).toMatchObject({
			id: "post_1",
			status: "published",
		});
		expect(seen).toEqual([
			"/_emdash/api/content/posts?status=published&limit=1",
		]);
	});
});
