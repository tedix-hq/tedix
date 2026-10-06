import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	CmsMediaBucketCreateOutcomeUnknownError,
	hasReviewedCmsHumanAuth,
	planCmsHumanAuthorityCarry,
	deleteCmsMediaBucket,
	deprovisionCms,
	inspectCmsMediaBucket,
	provisionCmsMediaBucket,
} from "./cms";

const config = { accountId: "account-1", apiToken: "token" };

afterEach(() => vi.unstubAllGlobals());

describe("CMS media bucket provisioning", () => {
	it("reports an existing tenant bucket without mutating it", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				result: { name: "tedix-cms-media-acme" },
				errors: [],
			}),
		);
		vi.stubGlobal("fetch", fetch);

		await expect(inspectCmsMediaBucket(config, "acme")).resolves.toEqual({
			bucketName: "tedix-cms-media-acme",
			exists: true,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("creates a missing bucket and is explicit about the mutation", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ success: false, result: null, errors: [{ message: "not found" }] },
					{ status: 404 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ success: true, result: {}, errors: [] }),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: { name: "tedix-cms-media-acme" },
					errors: [],
				}),
			);
		vi.stubGlobal("fetch", fetch);

		await expect(provisionCmsMediaBucket(config, "acme")).resolves.toEqual({
			bucketName: "tedix-cms-media-acme",
			exists: true,
			created: true,
		});
		expect(fetch.mock.calls[1]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ name: "tedix-cms-media-acme" }),
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("does not mistake an authorization failure for a missing bucket", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					{
						success: false,
						result: null,
						errors: [{ message: "forbidden" }],
					},
					{ status: 403 },
				),
			),
		);

		await expect(inspectCmsMediaBucket(config, "acme")).rejects.toThrow(
			"R2 bucket inspection failed: forbidden",
		);
	});

	it("marks transport and response parse failures after POST as unknown outcomes", async () => {
		for (const failure of ["transport", "invalid-json", "invalid-shape"]) {
			const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					if (failure === "transport") throw new Error("connection reset");
					if (failure === "invalid-shape") return Response.json({});
					return new Response("invalid JSON", { status: 200 });
				}
				return Response.json(
					{ success: false, result: null, errors: [{ message: "not found" }] },
					{ status: 404 },
				);
			});
			vi.stubGlobal("fetch", fetch);
			await expect(
				provisionCmsMediaBucket(config, "acme"),
			).rejects.toBeInstanceOf(CmsMediaBucketCreateOutcomeUnknownError);
		}
	});

	it("keeps a parsed provider denial as a definite failure", async () => {
		const fetch = vi.fn(async (_input: string, init?: RequestInit) =>
			Response.json(
				{
					success: false,
					result: null,
					errors: [
						{ message: init?.method === "POST" ? "denied" : "not found" },
					],
				},
				{ status: init?.method === "POST" ? 403 : 404 },
			),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(provisionCmsMediaBucket(config, "acme")).rejects.toThrow(
			"R2 bucket creation failed: denied",
		);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("requires provider readback after a successful creation response", async () => {
		const fetch = vi.fn(async (_input: string, init?: RequestInit) =>
			init?.method === "POST"
				? Response.json({ success: true, result: {}, errors: [] })
				: Response.json(
						{
							success: false,
							result: null,
							errors: [{ message: "not found" }],
						},
						{ status: 404 },
					),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(
			provisionCmsMediaBucket(config, "acme"),
		).rejects.toBeInstanceOf(CmsMediaBucketCreateOutcomeUnknownError);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
});

describe("CMS deprovision after a partial attempt", () => {
	const bindings = {
		bundlesBucket: {
			list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
			delete: vi.fn(),
		},
		platformDb: {
			prepare: vi.fn(() => ({
				bind: () => ({ run: async () => ({ success: true, meta: {} }) }),
			})),
		},
	} as unknown as Parameters<typeof deprovisionCms>[0];

	it("empties media before deleting its bucket", async () => {
		let objectListCount = 0;
		const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
			if (input.endsWith("/objects?per_page=1000"))
				return Response.json({
					success: true,
					result: objectListCount++ === 0 ? [{ key: "images/logo.png" }] : [],
					errors: [],
				});
			return Response.json({ success: true, result: {}, errors: [] });
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			deprovisionCms(bindings, "acme", () =>
				deleteCmsMediaBucket(config, "acme"),
			),
		).resolves.toMatchObject({
			success: true,
			deletedR2: true,
		});
		expect(
			fetch.mock.calls.find(
				([url, init]) =>
					url.endsWith("/objects/images/logo.png") && init?.method === "DELETE",
			),
		).toBeDefined();
		const bucketDelete = fetch.mock.calls.findIndex(
			([url, init]) =>
				url.endsWith("/r2/buckets/tedix-cms-media-acme") &&
				init?.method === "DELETE",
		);
		const objectDelete = fetch.mock.calls.findIndex(
			([url, init]) =>
				url.endsWith("/objects/images/logo.png") && init?.method === "DELETE",
		);
		expect(bucketDelete).toBeGreaterThan(objectDelete);
	});

	it("reports R2 authorization failure instead of claiming cleanup succeeded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
				input.includes("/r2/buckets/")
					? Response.json(
							{
								success: false,
								result: null,
								errors: [{ message: "Authentication error" }],
							},
							{ status: 403 },
						)
					: Response.json({ success: true, result: {}, errors: [] }),
			),
		);

		await expect(
			deprovisionCms(bindings, "acme", () =>
				deleteCmsMediaBucket(config, "acme"),
			),
		).resolves.toMatchObject({
			success: false,
			deletedR2: false,
			errors: ["R2: R2 bucket inspection failed: Authentication error"],
		});
	});

	it("drains every started media deletion before reporting a sibling failure", async () => {
		let finishSecond!: () => void;
		const secondFinished = new Promise<void>((resolve) => {
			finishSecond = resolve;
		});
		let secondStarted!: () => void;
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const fetch = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/objects?per_page=1000"))
				return Response.json({
					success: true,
					result: [{ key: "first.png" }, { key: "second.png" }],
					errors: [],
				});
			if (init?.method === "DELETE" && input.endsWith("/objects/first.png"))
				return Response.json(
					{ success: false, result: null, errors: [{ message: "denied" }] },
					{ status: 403 },
				);
			if (init?.method === "DELETE" && input.endsWith("/objects/second.png")) {
				secondStarted();
				await secondFinished;
			}
			return Response.json({ success: true, result: {}, errors: [] });
		});
		vi.stubGlobal("fetch", fetch);
		let settled = false;
		const deletion = deleteCmsMediaBucket(config, "acme").finally(() => {
			settled = true;
		});
		await secondStartedPromise;
		await Promise.resolve();
		expect(settled).toBe(false);
		finishSecond();
		await expect(deletion).rejects.toThrow("R2 object deletion failed: denied");
		expect(fetch).not.toHaveBeenCalledWith(
			expect.stringMatching(/\/r2\/buckets\/tedix-cms-media-acme$/),
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("purges published static objects before clearing bundle rows", async () => {
		const keys = new Set(["acme/1/manifest.json", "static/acme/site.css"]);
		const events: string[] = [];
		const localBindings = {
			bundlesBucket: {
				list: vi.fn(async ({ prefix }: { prefix: string }) => ({
					objects: [...keys]
						.filter((key) => key.startsWith(prefix))
						.map((key) => ({ key })),
					truncated: false,
				})),
				delete: vi.fn(async (batch: string[]) => {
					events.push(`delete:${batch.join(",")}`);
					for (const key of batch) keys.delete(key);
				}),
			},
			platformDb: {
				prepare: vi.fn(() => ({
					bind: () => ({
						run: async () => {
							events.push("row");
						},
					}),
				})),
			},
		} as unknown as Parameters<typeof deprovisionCms>[0];
		const result = await deprovisionCms(
			localBindings,
			"acme",
			async () => true,
		);
		expect(result.success).toBe(true);
		expect(keys.size).toBe(0);
		expect(events).toEqual([
			"delete:acme/1/manifest.json",
			"delete:static/acme/site.css",
			"row",
		]);
	});
});

const emittedHumanAuthRoot =
	'import { i as authenticate$1, t as onRequest$8 } from "./chunks/middleware_current.mjs";\nvar authenticate = authenticate$1;\nasync function callAuth(request, authMode) { await authenticate(request, authMode.config); }';
const emittedHumanAuthChunk =
	'async function authenticateHumanAssertion(request, config) {\n\tconst assertion = request.headers.get("X-Tedix-CMS-Human-Assertion");\n\tif (!assertion) return null;\n\tconst runtime = env;\n\tconst keyText = runtime.CMS_HUMAN_AUTH_KEY;\n\tconst siteId = runtime.CMS_HUMAN_AUTH_SITE_ID;\n\tconst bundleEtag = runtime.CMS_HUMAN_AUTH_BUNDLE_ETAG;\n\tif (typeof keyText !== "string" || typeof siteId !== "string" || typeof bundleEtag !== "string") rejectDescopeAuth("human_assertion_disabled", "CMS human assertion is unavailable for this bundle");\n\tconst parts = assertion.split(".");\n\tif (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) rejectDescopeAuth("human_assertion_format", "Invalid CMS human assertion");\n\tconst [payloadText, signatureText] = parts;\n\tlet payload;\n\ttry {\n\t\tconst padded = payloadText.replace(/-/g, "+").replace(/_/g, "/");\n\t\tpayload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));\n\t} catch {\n\t\trejectDescopeAuth("human_assertion_json", "Invalid CMS human assertion");\n\t}\n\tconst key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), {\n\t\tname: "HMAC",\n\t\thash: "SHA-256"\n\t}, false, ["verify"]);\n\tconst signatureBase64 = signatureText.replace(/-/g, "+").replace(/_/g, "/");\n\tlet signature;\n\ttry {\n\t\tsignature = Uint8Array.from(atob(signatureBase64), (char) => char.charCodeAt(0));\n\t} catch {\n\t\trejectDescopeAuth("human_assertion_signature", "Invalid CMS human assertion");\n\t}\n\tif (!await crypto.subtle.verify("HMAC", key, signature.buffer, new TextEncoder().encode(payloadText))) rejectDescopeAuth("human_assertion_signature", "Invalid CMS human assertion");\n\tconst now = Math.floor(Date.now() / 1e3);\n\tconst url = new URL(request.url);\n\tif (payload.siteId !== siteId || payload.bundleEtag !== bundleEtag || payload.slug !== runtime.ORG_SLUG || payload.tenantId !== resolveRequiredTenantId(config) || payload.method !== request.method.toUpperCase() || payload.path !== url.pathname + url.search || typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now + 5 || payload.iat < now - 30 || payload.exp <= now || payload.exp > payload.iat + 30 || ![\n\t\t10,\n\t\t40,\n\t\t50\n\t].includes(payload.role) || typeof payload.subject !== "string" || !payload.subject || typeof payload.email !== "string" || !payload.email || typeof payload.name !== "string" || !payload.name) rejectDescopeAuth("human_assertion_binding", "CMS human assertion is not valid for this request");\n\treturn {\n\t\temail: payload.email,\n\t\tname: payload.name,\n\t\trole: payload.role,\n\t\tsubject: payload.subject,\n\t\tmetadata: {\n\t\t\tdescopeUserId: payload.subject,\n\t\t\tauthProvider: "tedix-cms-human"\n\t\t}\n\t};\n}\nfunction readStringArray() {}\nasync function authenticate(request, config) {\n\tconst descopeConfig = config;\n\tconst internal = authenticateInternalRequest(request, descopeConfig);\n\tif (internal) return internal;\n\tconst assertedHuman = await authenticateHumanAssertion(request, descopeConfig);\n\tif (assertedHuman) return assertedHuman;\n\tconst projectId = resolveProjectId(descopeConfig);\n\tconst baseUrl = resolveBaseUrl(descopeConfig);\n\tconst tokens = extractDescopeTokens(request);\n\tif (!tokens) rejectDescopeAuth("missing_session", "No Descope session token found (Authorization header or DS cookie)");\n\tconst jwks = getJwks(projectId, baseUrl);\n\tlet payload;\n\ttry {\n\t\tpayload = (await jwtVerify(tokens.sessionJwt, jwks, { clockTolerance: 60 })).payload;\n\t} catch (err) {\n\t\tconst msg = err instanceof Error ? err.message : String(err);\n\t\trejectDescopeAuth(`jwt_validation:${err && typeof err === "object" && "code" in err ? String(err.code) : "unknown"}`, `Descope JWT validation failed: ${msg}`);\n\t}\n\ttry {\n\t\tassertDescopeSessionBoundary(payload, {\n\t\t\tbaseUrl,\n\t\t\tprojectId\n\t\t});\n\t} catch (error) {\n\t\tconst message = error instanceof Error ? error.message : String(error);\n\t\trejectDescopeAuth(message.includes("issuer") ? "issuer_mismatch" : "audience_mismatch", message);\n\t}\n\tconst email = payload.email;\n\tif (!email) rejectDescopeAuth("missing_email", "Descope JWT missing email claim");\n\tconst role = resolveDescopeTenantRole(payload, descopeConfig);\n\treturn {\n\t\temail,\n\t\tname: await resolveDisplayName({\n\t\t\tbaseUrl,\n\t\t\temail,\n\t\t\tpayload,\n\t\t\tprojectId,\n\t\t\trefreshJwt: tokens.refreshJwt\n\t\t}),\n\t\trole,\n\t\tsubject: payload.sub,\n\t\tmetadata: {\n\t\t\ttediId: payload.tediId,\n\t\t\tdescopeUserId: payload.descopeUserId,\n\t\t\ttenants: normalizeTenantsClaim(payload.tenants),\n\t\t\tpermissions: payload.permissions\n\t\t}\n\t};\n}\n//#endregion\n//#region node_modules/@standardserver/shared/dist/index.mjs\nexport { authenticate as i };';
describe("Manifest-listed native auth chunk verification", () => {
	it("automatic activation reads only the manifest-listed auth graph before carrying the marker", async () => {
		const reads: string[] = [];
		const statement = {
			bind: () => statement,
			first: async () => ({ marker: "old-etag" }),
		};
		const db = { prepare: () => statement } as unknown as Parameters<
			typeof planCmsHumanAuthorityCarry
		>[0];
		const plan = await planCmsHumanAuthorityCarry(db, {
			slug: "acme",
			previousActiveEtag: "old-etag",
			targetEtag: "new-etag",
			modules: [
				"virtual_astro_middleware.mjs",
				"chunks/middleware_current.mjs",
			],
			readModule: async (name) => {
				reads.push(name);
				return name === "virtual_astro_middleware.mjs"
					? emittedHumanAuthRoot
					: emittedHumanAuthChunk;
			},
		});
		expect(plan.outcome).toBe("carried");
		expect(plan.statement).not.toBeNull();
		expect(reads).toEqual([
			"virtual_astro_middleware.mjs",
			"chunks/middleware_current.mjs",
		]);
	});

	const module = "chunks/middleware_current.mjs";
	const graph = (
		chunk = emittedHumanAuthChunk,
		modules = ["virtual_astro_middleware.mjs", module],
	) => ({
		modules,
		readModule: async (name: string) => (name === module ? chunk : null),
	});
	it("rejects retired inline auth even when its functions retain reviewed bytes", async () => {
		const inline =
			emittedHumanAuthChunk
				.slice(0, emittedHumanAuthChunk.indexOf("//#endregion"))
				.replace(
					"async function authenticate(",
					"async function authenticate$1(",
				) +
			"\nvar authenticate = authenticate$1;\nasync function callAuth(request, authMode) { await authenticate(request, authMode.config); }";
		expect(await hasReviewedCmsHumanAuth(inline)).toBe(false);
		expect(await hasReviewedCmsHumanAuth(inline, graph())).toBe(false);
	});
	it("accepts exact emitted import/export with reviewed native functions", async () => {
		expect(await hasReviewedCmsHumanAuth(emittedHumanAuthRoot, graph())).toBe(
			true,
		);
	});
	it("accepts a reviewed shared theme chunk larger than the historical root limit", async () => {
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph(
					" ".repeat(
						1576264 -
							new TextEncoder().encode(emittedHumanAuthChunk).byteLength,
					) + emittedHumanAuthChunk,
				),
			),
		).toBe(true);
		expect(
			await hasReviewedCmsHumanAuth(" ".repeat(1024 * 1024 + 1), graph()),
		).toBe(false);
	});

	it("rejects dispatch and verifier tampering", async () => {
		for (const chunk of [
			emittedHumanAuthChunk.replace(
				"if (assertedHuman) return assertedHuman;",
				"if (assertedHuman) return null;",
			),
			emittedHumanAuthChunk.replace("payload.siteId", "payload.otherId"),
		])
			expect(
				await hasReviewedCmsHumanAuth(emittedHumanAuthRoot, graph(chunk)),
			).toBe(false);
	});
	it("rejects escaping, unlisted, ambiguous and oversized modules", async () => {
		for (const path of [
			"../chunks/middleware_current.mjs",
			"./chunks/../middleware_current.mjs",
			"https://evil.test/chunk.mjs",
		])
			expect(
				await hasReviewedCmsHumanAuth(
					emittedHumanAuthRoot.replace("./" + module, path),
					graph(),
				),
			).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph(undefined, ["virtual_astro_middleware.mjs"]),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph(undefined, [module, module]),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph(" ".repeat(2 * 1024 * 1024 + 1)),
			),
		).toBe(false);
	});
	it("rejects reviewed declarations hidden in comments and alias reassignment", async () => {
		expect(
			await hasReviewedCmsHumanAuth(
				"/*\n" + emittedHumanAuthRoot + "\n*/",
				graph(),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph("/*\n" + emittedHumanAuthChunk + "\n*/"),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot + "\nauthenticate = other;",
				graph(),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot,
				graph(
					emittedHumanAuthChunk.replace(
						"authenticate as i",
						"authenticate as i, other as i",
					),
				),
			),
		).toBe(false);
	});

	it("rejects wrong/duplicate exports, extra imports and unreachable bindings", async () => {
		for (const chunk of [
			emittedHumanAuthChunk.replace("authenticate as i", "authenticate as j"),
			emittedHumanAuthChunk + "\nexport { authenticate as i };",
			emittedHumanAuthChunk.replace("authenticate as i", "other as i"),
		])
			expect(
				await hasReviewedCmsHumanAuth(emittedHumanAuthRoot, graph(chunk)),
			).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot +
					'\nimport { i as authenticate$1 } from "./chunks/other.mjs";',
				graph(),
			),
		).toBe(false);
		expect(
			await hasReviewedCmsHumanAuth(
				emittedHumanAuthRoot.replace(
					"var authenticate = authenticate$1;",
					"var authenticate = other;",
				),
				graph(),
			),
		).toBe(false);
	});
});
