import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	cmsAuditActor,
	encodeCmsHumanIdentity,
	isCmsHumanOAuthSubject,
	mapCmsEditorialRole,
	describeCmsHumanAuthDenial,
	requiresCmsHumanAuth,
	resolveCmsHumanAuthorization,
} from "./cms-human-auth";
import type { JWTPayload } from "@tedix/auth/types";
import {
	buildCmsAuthHeaderCandidates,
	callCmsRest,
	describeCmsAuthUnavailable,
	hasTenantMcpCredential,
	menuSetItems,
	type CmsProxyContext,
} from "./cms-proxy-runtime";
import { mediaUpload } from "./cms-proxy-media";
import { buildServiceKeyProvisionAuthCandidates } from "./service-key-auth";

const resolverStubs = vi.hoisted(() => ({
	authority: vi.fn(),
	editorial: vi.fn(),
}));
vi.mock("./storage", () => ({
	getCmsHumanSiteAuthority: resolverStubs.authority,
}));
vi.mock("@tedix/auth/descope", () => ({
	loadUserTenantEditorialIdentity: resolverStubs.editorial,
}));

vi.mock("cloudflare:workers", () => ({
	env: {
		CMS_HUMAN_AUTH_KEY: "tenant-key",
		CMS_HUMAN_AUTH_SITE_ID: "site-one",
		CMS_HUMAN_AUTH_BUNDLE_ETAG: "bundle-one",
		ORG_SLUG: "acme",
	},
}));

import { authenticate } from "../../templates/tedix/src/auth/descope";
import { mintCmsHumanAssertion } from "../../../cms-runtime/src/tenant-human-auth";

async function signedHumanRequest(
	overrides: Record<string, unknown> = {},
): Promise<Request> {
	const url = "https://acme.cms.tedix.dev/_emdash/api/content?locale=de";
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		siteId: "site-one",
		slug: "acme",
		bundleEtag: "bundle-one",
		tenantId: "org_acme",
		subject: "user-one",
		email: "editor@example.com",
		name: "Editor",
		role: 40,
		method: "GET",
		path: "/_emdash/api/content?locale=de",
		iat: now,
		exp: now + 30,
		...overrides,
	};
	const payload = btoa(JSON.stringify(claims))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("tenant-key"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
	);
	let binary = "";
	for (const byte of signature) binary += String.fromCharCode(byte);
	const mac = btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return new Request(url, {
		headers: { "X-Tedix-CMS-Human-Assertion": `${payload}.${mac}` },
	});
}

describe("CMS editorial authority", () => {
	beforeEach(() => {
		resolverStubs.authority.mockReset().mockResolvedValue({
			siteId: "site-one",
			tenantId: "org_acme",
			activeBundleEtag: "bundle-one",
			humanAssertionBundleEtag: "bundle-one",
		});
		resolverStubs.editorial.mockReset().mockResolvedValue({
			email: "editor@example.com",
			name: "Editor",
			roles: ["editor"],
		});
	});
	it("uses the shared signed-token classifier for human versus AIH M2M", () => {
		const oauth = {
			sub: "user-one",
			client_id: "oauth-app",
			email: "user@example.com",
		} as JWTPayload;
		expect(isCmsHumanOAuthSubject(oauth)).toBe(true);
		expect(
			isCmsHumanOAuthSubject({
				sub: "machine-one",
				client_id: "m2m-app",
			} as JWTPayload),
		).toBe(false);
		expect(isCmsHumanOAuthSubject({ ...oauth, entityType: "tedi" })).toBe(
			false,
		);
		expect(
			isCmsHumanOAuthSubject({ client_id: "machine-only" } as JWTPayload),
		).toBe(false);
	});
	it("uses a live management user record for a validated human OAuth token", async () => {
		const oauth = {
			sub: "user-one",
			client_id: "oauth-app",
			email: "old@example.com",
		} as JWTPayload;
		const { identity: result, denial } = await resolveCmsHumanAuthorization({
			db: {} as D1Database,
			descope: { DESCOPE_PROJECT_ID: "project" },
			slug: "acme",
			user: oauth,
		});
		expect(denial).toBeNull();
		expect(result).toMatchObject({
			subject: "user-one",
			email: "editor@example.com",
			tenantId: "org_acme",
			role: 40,
		});
		expect(resolverStubs.editorial).toHaveBeenCalledWith(
			{ DESCOPE_PROJECT_ID: "project" },
			"user-one",
			"org_acme",
		);
		expect(cmsAuditActor(oauth, result)).toEqual({
			actorId: "user-one",
			actorType: "user",
		});
	});
	it("names the exact denial for a machine subject, missing user, missing role, stale marker, missing marker, and unavailable site", async () => {
		const base = {
			db: {} as D1Database,
			descope: { DESCOPE_PROJECT_ID: "project" },
			slug: "acme",
		};
		const human = { sub: "user-one", email: "user@example.com" } as JWTPayload;
		expect(
			await resolveCmsHumanAuthorization({
				...base,
				user: { sub: "machine-one", client_id: "machine" } as JWTPayload,
			}),
		).toEqual({ identity: null, denial: { reason: "not_human_subject" } });
		expect(resolverStubs.authority).not.toHaveBeenCalled();
		expect(resolverStubs.editorial).not.toHaveBeenCalled();

		resolverStubs.editorial.mockResolvedValueOnce(null);
		expect(
			await resolveCmsHumanAuthorization({ ...base, user: human }),
		).toEqual({
			identity: null,
			denial: {
				reason: "no_editorial_role",
				slug: "acme",
				tenantId: "org_acme",
			},
		});
		expect(resolverStubs.editorial).toHaveBeenCalledTimes(1);

		resolverStubs.editorial.mockResolvedValueOnce({
			email: "user@example.com",
			name: "User",
			roles: [],
		});
		expect(
			(await resolveCmsHumanAuthorization({ ...base, user: human })).denial,
		).toMatchObject({ reason: "no_editorial_role", tenantId: "org_acme" });

		resolverStubs.authority.mockResolvedValueOnce({
			siteId: "site-one",
			tenantId: "org_acme",
			activeBundleEtag: "rollback-bundle",
			humanAssertionBundleEtag: "bundle-one",
		});
		expect(
			await resolveCmsHumanAuthorization({ ...base, user: human }),
		).toEqual({
			identity: null,
			denial: {
				reason: "marker_stale",
				slug: "acme",
				markerEtag: "bundle-one",
				activeBundleEtag: "rollback-bundle",
			},
		});

		resolverStubs.authority.mockResolvedValueOnce({
			siteId: "site-one",
			tenantId: "org_acme",
			activeBundleEtag: "bundle-one",
			humanAssertionBundleEtag: null,
		});
		expect(
			await resolveCmsHumanAuthorization({ ...base, user: human }),
		).toEqual({
			identity: null,
			denial: {
				reason: "marker_missing",
				slug: "acme",
				activeBundleEtag: "bundle-one",
			},
		});

		resolverStubs.authority.mockResolvedValueOnce(null);
		expect(
			await resolveCmsHumanAuthorization({ ...base, user: human }),
		).toEqual({
			identity: null,
			denial: { reason: "site_unavailable", slug: "acme" },
		});
		// Marker and site denials never reach Descope.
		expect(resolverStubs.editorial).toHaveBeenCalledTimes(2);
	});
	it("explains every denial with the etags, tenant, and activation hint, and no secret", () => {
		const stale = describeCmsHumanAuthDenial({
			reason: "marker_stale",
			slug: "acme",
			markerEtag: "bundle-one",
			activeBundleEtag: "bundle-two",
		});
		expect(stale).toContain("bundle-one");
		expect(stale).toContain("bundle-two");
		expect(stale).toContain("get_human_auth_activation");
		expect(stale).toContain("set_human_auth_activation");
		const missing = describeCmsHumanAuthDenial({
			reason: "marker_missing",
			slug: "acme",
			activeBundleEtag: "bundle-two",
		});
		expect(missing).toContain("no human-auth marker");
		expect(missing).toContain("set_human_auth_activation");
		expect(
			describeCmsHumanAuthDenial({
				reason: "no_editorial_role",
				slug: "acme",
				tenantId: "org_acme",
			}),
		).toContain("no editorial role in tenant org_acme");
		expect(
			describeCmsHumanAuthDenial({ reason: "site_unavailable", slug: "acme" }),
		).toContain("not active");
		expect(
			describeCmsHumanAuthDenial({ reason: "unverified_bearer" }),
		).toContain("could not be verified");
		expect(
			describeCmsHumanAuthDenial({ reason: "not_human_subject" }),
		).toContain("not a human OAuth subject");
	});
	it("surfaces the denial reason in the UNAUTHORIZED tool error instead of a generic hint", async () => {
		const dispatch = vi.fn(async () => Response.json({ success: true }));
		const base: CmsProxyContext = {
			orgSlug: "acme",
			environment: "production",
			forwardedAuth: undefined,
			humanAuthRequired: true,
			humanIdentity: null,
			serviceApiKey: "ec_pat_site_admin",
			internalAuthToken: "shared",
			cmsDispatch: { fetch: dispatch } as unknown as Fetcher,
		};
		const stale = await callCmsRest(
			{
				...base,
				humanAuthDenial: {
					reason: "marker_stale",
					slug: "acme",
					markerEtag: "bundle-one",
					activeBundleEtag: "bundle-two",
				},
			},
			"schema_list_collections",
			{},
		);
		expect(stale.isError).toBe(true);
		expect(stale.content[0]?.text).toMatch(
			/^\[UNAUTHORIZED\] Human CMS auth marker for site "acme" is stale: .*bundle-one.*bundle-two.*set_human_auth_activation/,
		);
		expect(stale.content[0]?.text).not.toContain("ec_pat_site_admin");
		expect(stale.content[0]?.text).not.toContain("shared");
		expect(dispatch).not.toHaveBeenCalled();

		// No denial recorded and no identity: the forwarded bearer never verified.
		expect(describeCmsAuthUnavailable(base)).toContain("could not be verified");
		expect(
			describeCmsAuthUnavailable({
				...base,
				humanAuthDenial: { reason: "unverified_bearer" },
			}),
		).toContain("could not be verified");
		expect(
			describeCmsAuthUnavailable({
				...base,
				humanAuthDenial: {
					reason: "no_editorial_role",
					slug: "acme",
					tenantId: "org_acme",
				},
			}),
		).toContain("tenant org_acme");
		expect(
			describeCmsAuthUnavailable({
				...base,
				humanAuthDenial: { reason: "site_unavailable", slug: "acme" },
			}),
		).toContain("not active");
		// A resolved identity that cannot be carried is a configuration gap, not a user problem.
		expect(
			describeCmsAuthUnavailable({
				...base,
				internalAuthToken: undefined,
				humanIdentity: {
					siteId: "site-one",
					slug: "acme",
					bundleEtag: "bundle-one",
					tenantId: "org_acme",
					subject: "editor-one",
					email: "editor@example.com",
					name: "Editor",
					role: 40,
				},
			}),
		).toContain("CMS_INTERNAL_AUTH_TOKEN");
		// A machine caller with nothing configured: no credential at all.
		const none = await callCmsRest(
			{
				...base,
				humanAuthRequired: false,
				serviceApiKey: undefined,
				internalAuthToken: undefined,
			},
			"schema_list_collections",
			{},
		);
		expect(none.content[0]?.text).toContain(
			"[UNAUTHORIZED] No credential at all",
		);
		expect(none.content[0]?.text).toContain("CMS_SERVICE_KEYS");
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("routes a verified tedi or M2M principal through the service PAT with machine attribution", async () => {
		const tedi = {
			sub: "tedi-cto",
			entityType: "tedi",
			tediId: "tedi-cto",
		} as unknown as JWTPayload;
		const m2m = { sub: "machine-one", client_id: "m2m-app" } as JWTPayload;
		for (const user of [tedi, m2m]) {
			const forwardedAuth = "aaa.bbb.ccc";
			const humanAuthRequired = requiresCmsHumanAuth(forwardedAuth, user);
			expect(humanAuthRequired).toBe(false);
			const ctx: CmsProxyContext = {
				orgSlug: "acme",
				environment: "production",
				// index.ts never forwards a machine bearer to Emdash.
				forwardedAuth: undefined,
				humanAuthRequired,
				humanIdentity: null,
				humanAuthDenial: null,
				serviceApiKey: "ec_pat_site_admin",
				internalAuthToken: "shared",
			};
			expect(
				buildCmsAuthHeaderCandidates(ctx).map((candidate) => candidate.source),
			).toEqual(["pat", "internal"]);
			expect(buildCmsAuthHeaderCandidates(ctx)[0]?.headers.Authorization).toBe(
				"Bearer ec_pat_site_admin",
			);
		}
		expect(cmsAuditActor(tedi, null)).toEqual({
			actorId: "tedi-cto",
			actorType: "tedi",
		});
		expect(cmsAuditActor(m2m, null)).toEqual({
			actorId: "machine-one",
			actorType: "m2m",
		});
		// The same PAT is never offered to a rejected human.
		expect(
			buildCmsAuthHeaderCandidates({
				orgSlug: "acme",
				environment: "production",
				forwardedAuth: undefined,
				humanAuthRequired: requiresCmsHumanAuth("aaa.bbb.ccc", {
					sub: "user-one",
					email: "user@example.com",
				} as JWTPayload),
				humanIdentity: null,
				humanAuthDenial: { reason: "site_unavailable", slug: "acme" },
				serviceApiKey: "ec_pat_site_admin",
				internalAuthToken: "shared",
			}),
		).toEqual([]);
	});
	it("maps only recognized tenant roles and denies unknown assignments", () => {
		expect(mapCmsEditorialRole(["owner"])).toBe(50);
		expect(mapCmsEditorialRole(["Content Manager"])).toBe(40);
		expect(mapCmsEditorialRole(["viewer"])).toBe(10);
		expect(mapCmsEditorialRole(["Member"])).toBe(40);
		expect(mapCmsEditorialRole([])).toBeNull();
		expect(mapCmsEditorialRole(["unrelated-role"])).toBeNull();
	});
	it("encodes human display names as UTF-8", () => {
		const encoded = encodeCmsHumanIdentity({
			siteId: "site",
			slug: "acme",
			bundleEtag: "etag",
			tenantId: "org_acme",
			subject: "user",
			email: "user@example.com",
			name: "李 😀",
			role: 40,
		});
		expect(
			new TextDecoder().decode(
				Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
			),
		).toContain("李 😀");
	});

	it("never falls back to a site PAT or admin token for a human caller", () => {
		expect(
			buildCmsAuthHeaderCandidates({
				orgSlug: "acme",
				environment: "production",
				forwardedAuth: undefined,
				humanAuthRequired: true,
				humanIdentity: null,
				serviceApiKey: "ec_pat_secret",
				internalAuthToken: "internal",
			}),
		).toEqual([]);
		expect(
			buildServiceKeyProvisionAuthCandidates({
				forwardedAuth: undefined,
				humanAuthRequired: true,
				internalAuthToken: "internal",
			}),
		).toEqual([]);
	});
	it("fails closed when an internal caller forwards an invalid user bearer", async () => {
		const dispatch = vi.fn(async () => Response.json({ success: true }));
		const ctx: CmsProxyContext = {
			orgSlug: "acme",
			environment: "production",
			forwardedAuth: undefined,
			humanAuthRequired: requiresCmsHumanAuth(
				"invalid-forwarded-bearer",
				undefined,
			),
			humanIdentity: null,
			serviceApiKey: "ec_pat_site_admin",
			internalAuthToken: "shared",
			cmsDispatch: { fetch: dispatch } as unknown as Fetcher,
		};
		expect(ctx.humanAuthRequired).toBe(true);
		expect(
			(await callCmsRest(ctx, "schema_list_collections", {})).isError,
		).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("treats a present invalid forwarded credential as human-required", () => {
		expect(requiresCmsHumanAuth("not-a-jwt", undefined)).toBe(true);
		expect(requiresCmsHumanAuth(undefined, undefined)).toBe(false);
		expect(
			requiresCmsHumanAuth("m2m.jwt.token", {
				sub: "machine",
				client_id: "m2m-app",
			} as JWTPayload),
		).toBe(false);
		expect(
			requiresCmsHumanAuth("tedi.jwt.token", {
				sub: "tedi",
				entityType: "tedi",
			} as unknown as JWTPayload),
		).toBe(false);
	});
	it("routes viewer media and menu calls through human REST despite a stored PAT", async () => {
		const seen: Request[] = [];
		const ctx: CmsProxyContext = {
			orgSlug: "acme",
			environment: "production",
			forwardedAuth: undefined,
			humanAuthRequired: true,
			humanIdentity: {
				siteId: "site-one",
				slug: "acme",
				bundleEtag: "bundle-one",
				tenantId: "org_acme",
				subject: "viewer-one",
				email: "viewer@example.com",
				name: "Viewer",
				role: 10,
			},
			serviceApiKey: "ec_pat_site_admin",
			internalAuthToken: "shared",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push(request);
					return Response.json({ error: "denied" }, { status: 403 });
				},
			} as unknown as Fetcher,
		};
		expect(hasTenantMcpCredential(ctx)).toBe(false);
		expect(
			(
				await mediaUpload(ctx, {
					filename: "a.txt",
					mimeType: "text/plain",
					dataBase64: "YQ==",
				})
			).isError,
		).toBe(true);
		expect((await menuSetItems(ctx, { name: "main", items: [] })).isError).toBe(
			true,
		);
		expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
			"/_emdash/api/media",
			"/_emdash/api/menus/main/items",
		]);
		expect(seen[1]?.method).toBe("PUT");
		for (const request of seen) {
			expect(request.headers.get("Authorization")).toBeNull();
			expect(request.headers.get("X-Tedix-CMS-Human-Identity")).toBeTruthy();
			expect(request.headers.get("X-Tedix-CMS-Internal-Auth")).toBeNull();
		}
	});
	it("routes an Editor read through the human assertion REST candidate", async () => {
		let observed: Request | undefined;
		const ctx: CmsProxyContext = {
			orgSlug: "acme",
			environment: "production",
			forwardedAuth: undefined,
			humanAuthRequired: true,
			humanIdentity: {
				siteId: "site-one",
				slug: "acme",
				bundleEtag: "bundle-one",
				tenantId: "org_acme",
				subject: "editor-one",
				email: "editor@example.com",
				name: "Editor",
				role: 40,
			},
			serviceApiKey: "ec_pat_site_admin",
			internalAuthToken: "shared",
			cmsDispatch: {
				fetch: async (request: Request) => {
					observed = request;
					return Response.json({ success: true, data: [] });
				},
			} as unknown as Fetcher,
		};
		expect(
			(await callCmsRest(ctx, "schema_list_collections", {})).isError,
		).not.toBe(true);
		expect(new URL(observed!.url).pathname).toBe(
			"/_emdash/api/schema/collections",
		);
		expect(observed!.headers.get("X-Tedix-CMS-Human-Identity")).toBeTruthy();
		expect(observed!.headers.get("Authorization")).toBeNull();
	});
});

describe("assertion-aware Emdash auth adapter", () => {
	const config = { tenantId: "org_acme" };
	it("accepts the exact assertion minted by the parent runtime", async () => {
		const request = new Request(
			"https://acme.cms.tedix.dev/_emdash/api/content?locale=de",
		);
		const assertion = await mintCmsHumanAssertion({
			key: "tenant-key",
			identity: {
				siteId: "site-one",
				slug: "acme",
				bundleEtag: "bundle-one",
				tenantId: "org_acme",
				subject: "user-one",
				email: "editor@example.com",
				name: "Editor",
				role: 40,
			},
			request,
		});
		request.headers.set("X-Tedix-CMS-Human-Assertion", assertion);
		expect(await authenticate(request, config)).toMatchObject({
			role: 40,
			subject: "user-one",
		});
	});
	it("keeps the exact human role and identity", async () => {
		const result = await authenticate(await signedHumanRequest(), config);
		expect(result).toMatchObject({
			email: "editor@example.com",
			role: 40,
			subject: "user-one",
		});
	});
	it("rejects a wrong tenant, site, bundle, route, or expired assertion", async () => {
		for (const claims of [
			{ tenantId: "org_other" },
			{ siteId: "site-other" },
			{ bundleEtag: "bundle-other" },
			{ path: "/_emdash/api/other" },
			{ exp: Math.floor(Date.now() / 1000) - 1 },
		]) {
			await expect(
				authenticate(await signedHumanRequest(claims), config),
			).rejects.toThrow();
		}
	});
	it("rejects a modified signature before accepting any claimed role", async () => {
		const request = await signedHumanRequest({ role: 50 });
		const assertion = request.headers.get("X-Tedix-CMS-Human-Assertion")!;
		const [payload, mac] = assertion.split(".") as [string, string];
		request.headers.set(
			"X-Tedix-CMS-Human-Assertion",
			`${payload}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`,
		);
		await expect(authenticate(request, config)).rejects.toThrow();
	});
});
