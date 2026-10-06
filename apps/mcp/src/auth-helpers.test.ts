import { TokenValidationError } from "@tedix/auth/jwt";
import { issueDelegatedMcpToken } from "@tedix/auth/delegated-mcp-token";
import {
	LOCAL_DEMO_TOKEN,
	LOCAL_DEMO_PROJECT_ID,
	LOCAL_DEMO_TENANT_ID,
} from "@tedix/auth/local-demo";
import {
	CAPABILITY_SCOPES,
	hasScope,
	resolveTediScopes,
} from "@tedix/mcp-shared/auth/scopes";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const validateTokenMock = vi.hoisted(() => vi.fn());

vi.mock("@tedix/auth/jwt", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tedix/auth/jwt")>();
	return { ...actual, validateToken: validateTokenMock };
});

import {
	intersectScopes,
	extractRequiredScopes,
	invalidateAihM2mClientScopeCache,
	isTrustedBrowserBridge,
	resolveAihM2mClientScopeContext,
	resolveAihM2mTediOrganizationId,
	resolveExternalAgentSessionAuth,
	resolveMcpExpectedAudience,
	resolveMcpTokenValidationAudience,
	shouldEnforceTenantMatchForOAuth,
	validateAuth,
	validateHumanMcpSelection,
} from "./auth-helpers";
import type { AppTool } from "./mcp/server-context";

const originalFetch = globalThis.fetch;

describe("multi-organization MCP consent", () => {
	const config = {
		audience: "https://connect.mcp.tedix.dev/mcp",
		mcpServerId: "test-mcp-server",
		multiOrganization: true,
	};
	const payload = {
		iss: "Ptest",
		iat: 1,
		exp: 2,
		aud: config.audience,
		azp: "test-client",
		sub: "user-1",
		dci: "consent-1",
		tedixConsentRevision: "00000000-0000-4000-8000-000000000001",
		token_type: "access_token",
		scope: "openid offline_access mcp:apps.read mcp:work.read",
		tedixSelectedOrganizations: ["org_tedix", "org_sample"],
	};

	it("requires signed revision, exact single selection and matching tenant for human resources", async () => {
		const fetch = vi.fn();
		const env = { API_SERVICE: { fetch } } as unknown as CloudflareEnv;
		const singleConfig = { ...config, multiOrganization: false };
		for (const token of [
			{ ...payload, tedixConsentRevision: undefined },
			{ ...payload, dct: "org_tedix" },
			{ ...payload, tedixSelectedOrganizations: ["org_tedix"], dct: "other" },
		]) {
			expect(
				await validateHumanMcpSelection(token, env, singleConfig),
			).toBeNull();
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["Authorization", "X-API-Key"])(
		"checks revoked and unversioned human grants identically through %s",
		async (header) => {
			const fetch = vi
				.fn()
				.mockResolvedValue(
					Response.json({ json: { allowed: false, organizations: [] } }),
				);
			const dispatch = vi.fn();
			const env = {
				DESCOPE_PROJECT_ID: "Ptest",
				API_SERVICE: { fetch },
			} as unknown as CloudflareEnv;
			for (const human of [
				payload,
				{ ...payload, tedixConsentRevision: undefined },
			]) {
				const encoded = `eyJ.${btoa(JSON.stringify(human)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.sig`;
				validateTokenMock.mockResolvedValueOnce(human);
				const request = new Request(config.audience, {
					headers: {
						[header]:
							header === "Authorization" ? `Bearer ${encoded}` : encoded,
					},
				});
				const auth = await validateAuth(request, env, {
					expectedAudience: config.audience,
					mcpServerId: config.mcpServerId,
				});
				expect(auth).toMatchObject({ type: "oauth", userId: human.sub });
				if (auth && !(auth instanceof Response) && auth.type === "oauth") {
					const selection = await validateHumanMcpSelection(
						auth.payload,
						env,
						config,
					);
					expect(selection).toBeNull();
					if (selection) dispatch();
				}
			}
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(dispatch).not.toHaveBeenCalled();
		},
	);

	it("requires a live grant for the exact selected organizations on every request", async () => {
		const fetch = vi.fn(async (request: Request) => {
			const input = (await request.json()) as {
				json?: Record<string, unknown>;
			};
			expect(input.json).toMatchObject({
				mcpServerId: config.mcpServerId,
				clientId: "test-client",
				consentId: "consent-1",
				consentRevision: "00000000-0000-4000-8000-000000000001",
				selectedTenantIds: ["org_tedix", "org_sample"],
				tokenScopes: ["mcp:apps.read", "mcp:work.read"],
			});
			return Response.json({
				json: {
					allowed: true,
					organizations: [
						{
							organizationId: "id-1",
							descopeTenantId: "org_tedix",
							gatewaySlug: "tedix",
						},
						{
							organizationId: "id-2",
							descopeTenantId: "org_sample",
							gatewaySlug: "sample",
						},
					],
				},
			});
		});
		const env = { API_SERVICE: { fetch } } as unknown as CloudflareEnv;
		await expect(
			validateHumanMcpSelection(
				{ ...payload, aud: [payload.azp, "Ptest", config.audience] },
				env,
				config,
			),
		).resolves.toMatchObject({
			organizations: [{ gatewaySlug: "tedix" }, { gatewaySlug: "sample" }],
		});
		fetch.mockResolvedValueOnce(
			Response.json({ json: { allowed: false, organizations: [] } }),
		);
		await expect(
			validateHumanMcpSelection(payload, env, config),
		).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects wrong audience, missing client, duplicate tenants before API access", async () => {
		const fetch = vi.fn();
		const env = { API_SERVICE: { fetch } } as unknown as CloudflareEnv;
		for (const bad of [
			{ aud: [payload.azp, payload.iss] },
			{ aud: [config.audience, "Pother"] },
			{ aud: [config.audience, "https://another.example/mcp"] },
			{ aud: "https://another.mcp.tedix.dev/mcp" },
			{ azp: undefined },
			{ tedixConsentRevision: undefined },
			{ tedixSelectedOrganizations: ["org_tedix", "org_tedix"] },
		]) {
			await expect(
				validateHumanMcpSelection({ ...payload, ...bad }, env, config),
			).resolves.toBeNull();
		}
		expect(fetch).not.toHaveBeenCalled();
	});
	it("passes explicitly granted platform authority to the live verifier and preserves exact organization selection", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				json: {
					allowed: true,
					organizations: [
						{
							organizationId: "id-1",
							descopeTenantId: "org_tedix",
							gatewaySlug: "tedix",
						},
						{
							organizationId: "id-2",
							descopeTenantId: "org_sample",
							gatewaySlug: "sample",
						},
					],
				},
			}),
		);
		const env = { API_SERVICE: { fetch } } as unknown as CloudflareEnv;
		const admin = { ...payload, scope: "mcp:apps.read platform:admin" };
		await expect(
			validateHumanMcpSelection(admin, env, config),
		).resolves.toMatchObject({
			organizations: [{ gatewaySlug: "tedix" }, { gatewaySlug: "sample" }],
		});
		const request = fetch.mock.calls[0]![0] as Request;
		expect(await request.json()).toMatchObject({
			json: {
				tokenScopes: ["mcp:apps.read", "platform:admin"],
				selectedTenantIds: payload.tedixSelectedOrganizations,
				consentRevision: payload.tedixConsentRevision,
			},
		});
		fetch.mockResolvedValueOnce(
			Response.json({ json: { allowed: false, organizations: [] } }),
		);
		await expect(
			validateHumanMcpSelection(admin, env, config),
		).resolves.toBeNull();
		fetch.mockResolvedValueOnce(
			Response.json({
				json: {
					allowed: true,
					organizations: [
						{
							organizationId: "id-1",
							descopeTenantId: "other",
							gatewaySlug: "other",
						},
						{
							organizationId: "id-2",
							descopeTenantId: "org_sample",
							gatewaySlug: "sample",
						},
					],
				},
			}),
		);
		await expect(
			validateHumanMcpSelection(admin, env, config),
		).resolves.toBeNull();
	});
});

describe("native connected Notion call scope extraction", () => {
	const notion = {
		toolId: "notion-tedix__notion-update-page",
		writeCapability: "destructive",
		annotations: { destructiveHint: true },
		config: {
			auth: { type: "connection", connectionId: "notion" },
			_aggregateConnectionProviderId: "notion",
		},
	} as unknown as AppTool;
	const request = (body: unknown) =>
		new Request("https://notion_tedix.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const call = (args: unknown) => ({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: notion.toolId, arguments: args },
	});

	it("uses the exact command arguments at the edge gate", async () => {
		expect(
			await extractRequiredScopes(
				request(
					call({
						page_id: "page",
						command: "insert_content",
						content: "New note",
					}),
				),
				undefined,
				[notion],
			),
		).toEqual(["connections.execute"]);
		expect(
			await extractRequiredScopes(
				request(
					call({
						page_id: "page",
						command: "replace_content",
						new_str: "replacement",
					}),
				),
				undefined,
				[notion],
			),
		).toEqual(["connections.execute", "connections.admin"]);
	});

	it("unions a batch and fails closed on a malformed Notion argument entry", async () => {
		expect(
			await extractRequiredScopes(
				request([
					call({ page_id: "page", command: "insert_content", content: "x" }),
					call({
						page_id: "page",
						command: "update_content",
						allow_deleting_content: true,
					}),
				]),
				undefined,
				[notion],
			),
		).toEqual(["connections.execute", "connections.admin"]);
		expect(
			await extractRequiredScopes(request(call(null)), undefined, [notion]),
		).toEqual(["connections.execute", "connections.admin"]);
	});
});

describe("Home-delegated MCP bearer validation", () => {
	it("accepts only the exact signed resource audience without Descope hydration", async () => {
		const audience = "https://tedix-unified.mcp.tedix.dev/mcp";
		const secret = "test-shared-service-secret";
		const { token } = await issueDelegatedMcpToken({
			secret,
			audience,
			runId: "child-run",
			homeRunId: "home-run",
			workItemId: "work-item",
			tediId: "tedi-id",
			organizationId: "org-id",
			scopes: ["mcp:apps.read"],
		});
		const request = new Request(audience, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const env = { PLATFORM_SERVICE_TOKEN: secret } as CloudflareEnv;
		expect(
			await validateAuth(request, env, { expectedAudience: audience }),
		).toMatchObject({
			type: "delegated-mcp",
			claims: {
				runId: "child-run",
				workItemId: "work-item",
				tediId: "tedi-id",
				organizationId: "org-id",
				scopes: ["mcp:apps.read"],
			},
		});
		const wrong = await validateAuth(request, env, {
			expectedAudience: "https://other.mcp.tedix.dev/mcp",
		});
		expect(wrong).toBeInstanceOf(Response);
		expect((wrong as Response).status).toBe(401);
		expect(validateTokenMock).not.toHaveBeenCalled();
	});
});

describe("local demo MCP identity", () => {
	const localEnv = {
		ENVIRONMENT: "development",
		DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
	} as CloudflareEnv;
	const request = (
		url = "http://demo-unified.localhost:3000/mcp",
		token = LOCAL_DEMO_TOKEN,
	) => new Request(url, { headers: { Authorization: `Bearer ${token}` } });
	it("uses the ordinary local owner with granular capabilities", async () => {
		const result = await validateAuth(request(), localEnv);
		expect(result).toMatchObject({
			type: "oauth",
			localDemo: true,
			userId: "local-demo-owner",
			organizationId: LOCAL_DEMO_TENANT_ID,
			scopes: [...CAPABILITY_SCOPES],
		});
		expect(validateTokenMock).not.toHaveBeenCalled();
	});
	it.each([
		{
			env: { ...localEnv, ENVIRONMENT: "production" },
			url: "http://localhost:3000/mcp",
			token: LOCAL_DEMO_TOKEN,
		},
		{
			env: { ...localEnv, DESCOPE_PROJECT_ID: "real-project" },
			url: "http://localhost:3000/mcp",
			token: LOCAL_DEMO_TOKEN,
		},
		{ env: localEnv, url: "https://example.com/mcp", token: LOCAL_DEMO_TOKEN },
		{
			env: localEnv,
			url: "http://localhost:3000/mcp",
			token: "wrong-demo-token",
		},
	])(
		"rejects a demo credential outside its exact local context: %j",
		async ({ env, url, token }) => {
			const result = await validateAuth(
				request(url, token),
				env as CloudflareEnv,
			);
			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(401);
		},
	);
	it("does not trust forwarded host or enable flags on an external URL", async () => {
		const req = request("https://example.com/mcp");
		req.headers.set("X-Tedix-Host", "demo-unified.localhost");
		const result = await validateAuth(req, {
			...localEnv,
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		} as CloudflareEnv);
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(401);
	});
	it("ignores forged tenant and scope headers from an external local client", async () => {
		const req = request();
		req.headers.set("CF-Connecting-IP", "127.0.0.1");
		req.headers.set("X-Service-Binding", "true");
		req.headers.set("X-Tedix-Org-Id", "other-org");
		req.headers.set("X-Tedix-Auth-Local-Demo", "true");
		req.headers.set("X-Tedix-Tedi-Scopes", "platform:admin *");
		const result = await validateAuth(stripServiceBindingMarker(req), localEnv);
		expect(result).toMatchObject({
			type: "oauth",
			organizationId: LOCAL_DEMO_TENANT_ID,
			scopes: [...CAPABILITY_SCOPES],
		});
	});
});

function envWithClients(clients: unknown[]) {
	const fetch = vi.fn(async (request: Request) => {
		expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe("platform:admin");
		return new Response(JSON.stringify({ json: { clients } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return {
		DESCOPE_PROJECT_ID: `project-${crypto.randomUUID()}`,
		API_SERVICE: { fetch },
	} as unknown as CloudflareEnv & { API_SERVICE: { fetch: typeof fetch } };
}

afterEach(() => {
	Object.defineProperty(globalThis, "fetch", {
		value: originalFetch,
		configurable: true,
		writable: true,
	});
	vi.restoreAllMocks();
	validateTokenMock.mockReset();
});

describe("resolveAihM2mTediOrganizationId", () => {
	it("prefers the tedi's live D1 organization over the served app", () => {
		expect(
			resolveAihM2mTediOrganizationId({
				liveOrganizationId: "customer-org",
				servedAppOrganizationId: "app-org",
			}),
		).toBe("customer-org");
	});

	it("uses the served app organization only when live tedi resolution is unavailable", () => {
		expect(
			resolveAihM2mTediOrganizationId({
				liveOrganizationId: null,
				servedAppOrganizationId: "app-org",
			}),
		).toBe("app-org");
	});

	it("fails closed instead of accepting the M2M JWT tenant as customer authority", () => {
		expect(resolveAihM2mTediOrganizationId({})).toBeNull();
	});
});

describe("resolveMcpExpectedAudience", () => {
	it("uses the serving resource for ordinary app auth", () => {
		expect(
			resolveMcpExpectedAudience({
				hostname: "acme.mcp.tedix.dev",
				authMode: "authenticated",
				configuredAudience: "https://unrelated.example/mcp",
			}),
		).toBe("https://acme.mcp.tedix.dev/mcp");
	});

	it("uses the relationship-specific audience for proxy targets", () => {
		expect(
			resolveMcpExpectedAudience({
				hostname: "reference.mcp.tedix.dev",
				authMode: "proxy-target",
				configuredAudience: " https://customer.mcp.example/mcp ",
			}),
		).toBe("https://customer.mcp.example/mcp");
	});

	it("fails closed when a proxy target has no audience mapping", () => {
		expect(
			resolveMcpExpectedAudience({
				hostname: "reference.mcp.tedix.dev",
				authMode: "proxy-target",
			}),
		).toBeNull();
	});
});

describe("validateAuth audience enforcement", () => {
	const expectedAudience = "https://customer.mcp.example/mcp";
	const encodePayload = (payload: Record<string, unknown>) =>
		btoa(JSON.stringify(payload))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
	const request = new Request("https://reference.mcp.tedix.dev/mcp", {
		headers: { Authorization: "Bearer eyJ.test.token" },
	});
	const env = {
		DESCOPE_PROJECT_ID: "project-id",
	} as unknown as CloudflareEnv;

	it("passes the exact resource as the primary audience", async () => {
		validateTokenMock.mockResolvedValue({
			sub: "user-1",
			iss: "https://api.descope.com/project-id",
			aud: expectedAudience,
			iat: 1,
			exp: 2,
		});

		await expect(
			validateAuth(request, env, { expectedAudience }),
		).resolves.toMatchObject({ type: "oauth", userId: "user-1" });
		expect(validateTokenMock).toHaveBeenCalledWith(
			"eyJ.test.token",
			expect.objectContaining({ audience: expectedAudience }),
		);
	});

	it("authenticates a CIMD client without fetching unused metadata", async () => {
		const clientId = "https://claude.ai/.well-known/oauth-client/test";
		const fetch = vi.fn(() => {
			throw new Error("Authentication must not fetch client metadata");
		});
		stubFetch(fetch as unknown as typeof globalThis.fetch);
		validateTokenMock.mockResolvedValue({
			sub: "user-1",
			dct: "org-1",
			client_id: clientId,
			scope: "mcp:apps.read",
			iss: "https://api.descope.com/project-id",
			aud: expectedAudience,
			iat: 1,
			exp: 2,
		});

		await expect(
			validateAuth(request, env, { expectedAudience }),
		).resolves.toMatchObject({
			type: "oauth",
			userId: "user-1",
			organizationId: "org-1",
			clientId,
			scopes: ["mcp:apps.read"],
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(validateTokenMock).toHaveBeenCalledWith(
			"eyJ.test.token",
			expect.objectContaining({ audience: expectedAudience }),
		);
	});

	it("rejects a token that the validator reports for an unrelated audience", async () => {
		validateTokenMock.mockRejectedValue(
			new TokenValidationError("Audience mismatch", "CLAIM_VALIDATION_FAILED"),
		);

		const result = await validateAuth(request, env, { expectedAudience });
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(401);
	});

	it("does not apply an OAuth resource audience to access-key validation", async () => {
		validateTokenMock.mockResolvedValue({
			sub: "access-key-subject",
			iss: "https://api.descope.com/project-id",
			aud: "project-id",
			iat: 1,
			exp: 2,
		});

		await expect(validateAuth(request, env)).resolves.toMatchObject({
			type: "oauth",
			userId: "access-key-subject",
		});
		expect(validateTokenMock).toHaveBeenCalledWith(
			"eyJ.test.token",
			expect.objectContaining({ audience: undefined }),
		);
	});

	it("revalidates a trusted browser bridge as its OAuth user", async () => {
		validateTokenMock.mockResolvedValue({
			sub: "user-1",
			dct: "T-org-1",
			iss: "https://api.descope.com/project-id",
			aud: "project-id",
			iat: 1,
			exp: 2,
		});
		const bridgedRequest = new Request("https://reference.mcp.tedix.dev/mcp", {
			headers: {
				Authorization: "Bearer eyJ.browser.session",
				"X-Service-Binding": "true",
				"X-Tedix-Browser-Bridge": "true",
			},
		});

		await expect(validateAuth(bridgedRequest, env)).resolves.toMatchObject({
			type: "oauth",
			userId: "user-1",
			organizationId: "T-org-1",
		});
		expect(validateTokenMock).toHaveBeenCalledWith(
			"eyJ.browser.session",
			expect.objectContaining({ audience: undefined }),
		);
	});

	it("accepts only API-resolved capability scopes on a trusted browser bridge", async () => {
		validateTokenMock.mockResolvedValue({
			sub: "user-1",
			dct: "T-org-1",
			iss: "https://api.descope.com/project-id",
			aud: "project-id",
			iat: 1,
			exp: 2,
		});
		const request = new Request("https://reference.mcp.tedix.dev/mcp", {
			headers: {
				Authorization: "Bearer eyJ.browser.session",
				"X-Service-Binding": "true",
				"X-Tedix-Browser-Bridge": "true",
				"X-Tedix-Browser-Scopes":
					"mcp:apps.read platform:admin mcp:* invented.scope",
			},
		});

		await expect(validateAuth(request, env)).resolves.toMatchObject({
			type: "oauth",
			userId: "user-1",
			scopes: ["mcp:apps.read"],
		});
	});

	it("ignores browser scope assertions on public ingress", async () => {
		validateTokenMock.mockResolvedValue({
			sub: "user-1",
			dct: "T-org-1",
			iss: "https://api.descope.com/project-id",
			aud: "project-id",
			iat: 1,
			exp: 2,
		});
		const request = new Request("https://reference.mcp.tedix.dev/mcp", {
			headers: {
				Authorization: "Bearer eyJ.browser.session",
				"X-Service-Binding": "true",
				"X-Tedix-Browser-Bridge": "true",
				"X-Tedix-Browser-Scopes": "mcp:apps.read",
				"CF-Connecting-IP": "192.0.2.1",
			},
		});

		await expect(
			validateAuth(stripServiceBindingMarker(request), env),
		).resolves.toMatchObject({
			type: "oauth",
			scopes: undefined,
		});
	});

	it.each([
		{
			label: "verified platform browser session",
			roles: ["platform-admin"],
			trusted: true,
			claims: {},
			scopes: undefined,
		},
		{
			label: "ordinary tenant owner",
			roles: ["owner"],
			trusted: true,
			claims: {},
			scopes: undefined,
		},
		{
			label: "tenant admin",
			roles: ["admin"],
			trusted: true,
			claims: {},
			scopes: undefined,
		},
		{
			label: "public spoofed bridge",
			roles: ["platform-admin"],
			trusted: false,
			claims: {},
			scopes: undefined,
		},
		{
			label: "explicit restricted grant",
			roles: ["platform-admin"],
			trusted: true,
			claims: { scope: "mcp:apps.read" },
			scopes: ["mcp:apps.read"],
		},
		{
			label: "client credential",
			roles: ["platform-admin"],
			trusted: true,
			claims: { client_id: "client-1" },
			scopes: undefined,
		},
		{
			label: "authorized party credential",
			roles: ["platform-admin"],
			trusted: true,
			claims: { azp: "client-1" },
			scopes: undefined,
		},
		{
			label: "tedi credential",
			roles: ["platform-admin"],
			trusted: true,
			claims: { entityType: "tedi" },
			scopes: undefined,
		},
	])(
		"preserves browser authority: $label",
		async ({ roles, trusted, claims, scopes }) => {
			validateTokenMock.mockResolvedValue({
				sub: "user-1",
				dct: "T-org-1",
				iss: "https://api.descope.com/project-id",
				aud: "project-id",
				iat: 1,
				exp: 2,
				roles,
				...claims,
			});
			const headers = new Headers({
				Authorization: "Bearer eyJ.browser.session",
				"X-Service-Binding": "true",
				"X-Tedix-Browser-Bridge": "true",
			});
			const request = new Request("https://reference.mcp.tedix.dev/mcp", {
				headers,
			});
			await expect(
				validateAuth(
					trusted ? request : stripServiceBindingMarker(request),
					env,
				),
			).resolves.toMatchObject({
				type: "oauth",
				userId: "user-1",
				organizationId: "T-org-1",
				scopes,
			});
		},
	);

	it("uses the signed AIH server issuer instead of a URL audience for M2M bearer tokens", async () => {
		const payload = {
			iss: "https://api.descope.com/v1/apps/agentic/project-id/server-id",
			sub: "TPAclientRecord",
			azp: "client-id",
			aud: ["client-id", "project-id"],
			iat: 1,
			exp: 2,
		};
		const token = `eyJ.${encodePayload(payload)}.sig`;
		validateTokenMock.mockResolvedValue(payload);

		await expect(
			validateAuth(
				new Request("https://reference.mcp.tedix.dev/mcp", {
					headers: { Authorization: `Bearer ${token}` },
				}),
				env,
				{ expectedAudience, mcpServerId: "server-id" },
			),
		).resolves.toMatchObject({ type: "oauth", userId: "TPAclientRecord" });
		expect(validateTokenMock).toHaveBeenCalledWith(
			token,
			expect.objectContaining({ audience: undefined }),
		);
	});
});

describe("resolveMcpTokenValidationAudience", () => {
	function token(payload: Record<string, unknown>): string {
		const encoded = btoa(JSON.stringify(payload))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		return `eyJ.${encoded}.sig`;
	}

	it("keeps URL audience enforcement for a different AIH MCP server", () => {
		expect(
			resolveMcpTokenValidationAudience({
				token: token({
					iss: "https://api.descope.com/v1/apps/agentic/project-id/other-server",
					azp: "client-id",
				}),
				projectId: "project-id",
				expectedAudience: "https://tedix-unified.mcp.tedix.dev/mcp",
				mcpServerId: "server-id",
			}),
		).toBe("https://tedix-unified.mcp.tedix.dev/mcp");
	});

	it("lets current Descope client-credentials tokens use signed client validation", () => {
		expect(
			resolveMcpTokenValidationAudience({
				token: token({
					iss: "https://api.descope.com/project-id",
					azp: "client-id",
					sub: "TPAclientRecord",
					aud: ["client-id", "project-id"],
				}),
				projectId: "project-id",
				expectedAudience: "https://tedix.mcp.tedix.dev/mcp",
				mcpServerId: "server-id",
			}),
		).toBeUndefined();
	});

	it("keeps URL audience enforcement for human OAuth tokens", () => {
		expect(
			resolveMcpTokenValidationAudience({
				token: token({
					iss: "https://api.descope.com/v1/apps/agentic/project-id/server-id",
					email: "operator@example.com",
				}),
				projectId: "project-id",
				expectedAudience: "https://tedix-unified.mcp.tedix.dev/mcp",
				mcpServerId: "server-id",
			}),
		).toBe("https://tedix-unified.mcp.tedix.dev/mcp");
	});
});

function stubFetch(fetch: typeof globalThis.fetch) {
	Object.defineProperty(globalThis, "fetch", {
		value: fetch,
		configurable: true,
		writable: true,
	});
}

describe("validateAuth service-binding kernel marker", () => {
	const env = {} as unknown as CloudflareEnv;

	it("carries kernel: true for service-binding callers sending X-Tedix-Kernel", async () => {
		const request = new Request("https://mcp.internal/mcp", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Kernel": "true",
				"X-Tedix-Acting-User": "user-123",
				"X-Tedix-Org-Id": "org-1",
				"X-Tedix-Tedi-Scopes": "mcp:messaging connections.execute",
			},
		});

		const result = await validateAuth(request, env);
		expect(result).toMatchObject({
			type: "service-binding",
			userId: "user-123",
			organizationId: "org-1",
			scopes: ["mcp:messaging", "connections.execute"],
			kernel: true,
		});
		// Acting user must not be conflated into tediId.
		expect(
			(result as { principal?: { tediId?: string } })?.principal?.tediId,
		).toBeUndefined();
	});

	it("leaves kernel unset for service-binding callers without the marker", async () => {
		const request = new Request("https://mcp.internal/mcp", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Acting-User": "user-123",
			},
		});

		const result = await validateAuth(request, env);
		expect(result).toMatchObject({ type: "service-binding", scopes: [] });
		expect((result as { kernel?: boolean })?.kernel).toBeUndefined();
	});

	it("ignores the marker on non-service-binding requests (spoof attempt from outside)", async () => {
		const request = new Request("https://tedix.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"CF-Connecting-IP": "203.0.113.7",
				"X-Tedix-Kernel": "true",
				"X-Tedix-Acting-User": "user-123",
			},
		});

		// Public ingress strips the binding marker, so the service-binding
		// branch is not taken. No Authorization header → not authenticated at
		// all; the kernel marker is dead.
		const result = await validateAuth(stripServiceBindingMarker(request), env);
		expect(result).toBeNull();
	});
});

describe("isTrustedBrowserBridge", () => {
	it("accepts the marker only across a service binding", () => {
		expect(
			isTrustedBrowserBridge(
				new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Browser-Bridge": "true",
				}),
			),
		).toBe(true);
	});

	it("rejects a public spoof even when both headers are present", () => {
		expect(
			isTrustedBrowserBridge(
				stripServiceBindingMarker(
					new Request("https://mcp.tedix.dev/mcp", {
						headers: {
							"X-Service-Binding": "true",
							"X-Tedix-Browser-Bridge": "true",
							"CF-Connecting-IP": "203.0.113.7",
						},
					}),
				).headers,
			),
		).toBe(false);
	});
});

describe("shouldEnforceTenantMatchForOAuth", () => {
	it("enforces tenant matching for ordinary human OAuth tokens", () => {
		const headers = new Headers({ "x-tedix-auth-type": "oauth" });

		expect(shouldEnforceTenantMatchForOAuth(headers, {})).toBe(true);
	});

	it("does not tenant-match trusted AIH M2M clients without tenant claims", () => {
		const headers = new Headers({
			"x-tedix-auth-type": "oauth",
			"x-tedix-auth-credential-mode": "aih-m2m",
		});

		expect(shouldEnforceTenantMatchForOAuth(headers, {})).toBe(false);
	});

	it("does not tenant-match direct tedi JWT payloads", () => {
		const headers = new Headers({ "x-tedix-auth-type": "oauth" });

		expect(
			shouldEnforceTenantMatchForOAuth(headers, { entityType: "tedi" }),
		).toBe(false);
	});
});

// NOTE: This invalidates the in-process cache only. The service-binding call
// from apps/api reaches one MCP isolate; the 5-min TTL covers remaining isolates.
describe("invalidateAihM2mClientScopeCache", () => {
	it.each([true, false])(
		"bounds fresh cache entries including hits=%s",
		async (hits) => {
			invalidateAihM2mClientScopeCache();
			const clients = Array.from({ length: 101 }, (_, index) => ({
				id: `bounded-record-${index}`,
				clientId: `bounded-client-${index}`,
				scopes: ["mcp:apps.read"],
				tags: ["ci:release-smoke"],
			}));
			const env = envWithClients(hits ? clients : []);
			const resolve = (index: number) =>
				resolveAihM2mClientScopeContext(
					env,
					{ sub: clients[index]!.id, client_id: clients[index]!.clientId },
					"bounded-server",
				);
			for (let index = 0; index < clients.length; index++) {
				const result = await resolve(index);
				if (hits) expect(result?.scopes).toEqual(["mcp:apps.read"]);
				else expect(result).toBeNull();
			}
			expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(101);
			await resolve(100);
			expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(101);
			await resolve(0);
			expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(102);
			expect(invalidateAihM2mClientScopeCache()).toBe(100);
		},
	);

	it("clears matching entries by mcpServerId and forces re-hydration on next resolve", async () => {
		const env = envWithClients([
			{
				id: "client-inv-1",
				clientId: "inv-client-1",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory"],
				tags: ["tedi:tedi-inv", "app:tedix-unified"],
			},
		]);

		// Prime the cache
		const first = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-inv-1", client_id: "inv-client-1" },
			"server-inv",
		);
		expect(first?.clientRecordId).toBe("client-inv-1");
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);

		// Invalidate by mcpServerId
		const cleared = invalidateAihM2mClientScopeCache({
			mcpServerId: "server-inv",
		});
		expect(cleared).toBeGreaterThan(0);

		// Next resolve must re-hydrate (fetch called again, not a cache hit)
		const second = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-inv-1", client_id: "inv-client-1" },
			"server-inv",
		);
		expect(second?.clientRecordId).toBe("client-inv-1");
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(2);
	});

	it("does not affect entries for a different mcpServerId", async () => {
		const envA = envWithClients([
			{
				id: "client-a",
				clientId: "client-a",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:observe"],
				tags: ["tedi:tedi-a", "app:tedix-unified"],
			},
		]);
		const envB = envWithClients([
			{
				id: "client-b",
				clientId: "client-b",
				name: "tedi:cfo (M2M)",
				scopes: ["mcp:observe"],
				tags: ["tedi:tedi-b", "app:tedix-unified"],
			},
		]);

		await resolveAihM2mClientScopeContext(
			envA,
			{ sub: "client-a", client_id: "client-a" },
			"server-a",
		);
		await resolveAihM2mClientScopeContext(
			envB,
			{ sub: "client-b", client_id: "client-b" },
			"server-b",
		);

		// Invalidate only server-a
		const cleared = invalidateAihM2mClientScopeCache({
			mcpServerId: "server-a",
		});
		expect(cleared).toBeGreaterThan(0);

		// server-b should still be cached (no extra fetch)
		await resolveAihM2mClientScopeContext(
			envB,
			{ sub: "client-b", client_id: "client-b" },
			"server-b",
		);
		expect(envB.API_SERVICE.fetch).toHaveBeenCalledTimes(1);

		// server-a should re-hydrate
		await resolveAihM2mClientScopeContext(
			envA,
			{ sub: "client-a", client_id: "client-a" },
			"server-a",
		);
		expect(envA.API_SERVICE.fetch).toHaveBeenCalledTimes(2);
	});

	it("clear all entries when called without filter", async () => {
		const env = envWithClients([
			{
				id: "client-all-1",
				clientId: "client-all-1",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:observe"],
				tags: ["tedi:tedi-all", "app:tedix-unified"],
			},
		]);

		await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-all-1", client_id: "client-all-1" },
			"server-all",
		);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);

		invalidateAihM2mClientScopeCache();

		await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-all-1", client_id: "client-all-1" },
			"server-all",
		);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(2);
	});
});

describe("resolveAihM2mClientScopeContext", () => {
	it("does not classify an email-less human as a registered machine by azp alone", async () => {
		const env = envWithClients([
			{
				id: "TPAmachine",
				clientId: "machine-client",
				scopes: ["platform:admin"],
				tags: ["ci:release-smoke"],
			},
		]);
		expect(
			await resolveAihM2mClientScopeContext(
				env,
				{ sub: "human-user", azp: "machine-client" },
				"binding-server",
			),
		).toBeNull();
		expect(
			await resolveAihM2mClientScopeContext(
				env,
				{
					sub: "human-user",
					azp: "machine-client",
					email: "human@example.test",
				},
				"binding-server",
			),
		).toBeNull();
		expect(
			await resolveAihM2mClientScopeContext(
				env,
				{ sub: "TPAmachine", azp: "wrong-client" },
				"binding-server",
			),
		).toBeNull();
		expect(
			await resolveAihM2mClientScopeContext(
				env,
				{
					sub: "TPAmachine",
					azp: "machine-client",
					email: "machine@example.test",
				},
				"binding-server",
			),
		).toMatchObject({ clientRecordId: "TPAmachine" });
	});

	it("recognizes only a complete canonical external-agent tag tuple", async () => {
		const organizationId = "00000000-0000-4000-8000-000000000001";
		const principalId = "00000000-0000-4000-8000-000000000002";
		const sessionId = "00000000-0000-4000-8000-000000000003";
		const env = envWithClients([
			{
				id: "external-client-record",
				clientId: "external-client",
				scopes: ["platform:admin"],
				tags: [
					"external-agent",
					`external-agent-org:${organizationId}`,
					`external-agent-principal:${principalId}`,
					`external-agent-session:${sessionId}`,
				],
			},
		]);
		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "external-client-record", client_id: "external-client" },
			`external-server-${crypto.randomUUID()}`,
		);
		expect(result?.externalAgent).toEqual({
			organizationId,
			principalId,
			sessionId,
		});
		const request = env.API_SERVICE.fetch.mock.calls[0]?.[0] as Request;
		const body = (await request.json()) as {
			json?: { clientId?: string; mcpServerId?: string };
		};
		expect(body.json?.clientId).toBe("external-client");
		expect(body.json?.mcpServerId).toMatch(/^external-server-/);
	});

	it("rejects an external client that also claims tedi identity", async () => {
		const env = envWithClients([
			{
				id: "mixed-client-record",
				clientId: "mixed-client",
				scopes: ["platform:admin"],
				tags: [
					"external-agent",
					"external-agent-org:00000000-0000-4000-8000-000000000001",
					"external-agent-principal:00000000-0000-4000-8000-000000000002",
					"external-agent-session:00000000-0000-4000-8000-000000000003",
					"tedi:00000000-0000-4000-8000-000000000004",
				],
			},
		]);
		expect(
			await resolveAihM2mClientScopeContext(
				env,
				{ sub: "mixed-client-record", client_id: "mixed-client" },
				`mixed-server-${crypto.randomUUID()}`,
			),
		).toBeNull();
	});
	it("hydrates tedi AIH client scopes even when Descope emits a generic scope string", async () => {
		const env = envWithClients([
			{
				id: "client-record-1",
				clientId: "client-1",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory", "platform:admin"],
				tags: ["tedi:tedi-1", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-1", client_id: "client-1", scope: "profile email" },
			"server-1",
		);

		expect(result?.clientRecordId).toBe("client-record-1");
		expect(result?.scopes).toEqual(["mcp:memory", "platform:admin"]);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not hydrate human OAuth tokens that include an email claim", async () => {
		const env = envWithClients([
			{
				id: "client-record-2",
				clientId: "client-2",
				scopes: ["platform:admin"],
				tags: ["tedi:tedi-2", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{
				client_id: "client-2",
				email: "ada@example.com",
				scope: "mcp:observe",
			},
			"server-2",
		);

		expect(result).toBeNull();
		expect(env.API_SERVICE.fetch).not.toHaveBeenCalled();
	});

	it("only trusts matched AIH clients tagged as tedis", async () => {
		const env = envWithClients([
			{
				id: "client-record-3",
				clientId: "client-3",
				name: "human-codex-client",
				scopes: ["platform:admin"],
				tags: ["app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-3", client_id: "client-3" },
			"server-3",
		);

		expect(result).toBeNull();
	});

	// Cache-poisoning regression: a transient search error or a create→search
	// propagation miss must not be cached as null for the full TTL, or valid
	// CLI-minted M2M credentials get rejected with tenant_mismatch.
	it("does not cache a transient search error (next call re-queries)", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("upstream hiccup", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						json: {
							clients: [
								{
									id: "client-record-err",
									clientId: "client-err",
									name: "tedi:cto (M2M)",
									scopes: ["mcp:observe"],
									tags: ["tedi:tedi-err", "app:tedix-unified"],
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		const env = {
			DESCOPE_PROJECT_ID: `project-${crypto.randomUUID()}`,
			API_SERVICE: { fetch },
		} as unknown as CloudflareEnv & { API_SERVICE: { fetch: typeof fetch } };

		const first = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-err", client_id: "client-err" },
			"server-err",
		);
		expect(first).toBeNull();

		// The error result must not be cached: the next call re-queries and wins.
		const second = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-err", client_id: "client-err" },
			"server-err",
		);
		expect(second?.clientRecordId).toBe("client-record-err");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("caches a genuine miss only briefly, re-querying after the short TTL", async () => {
		const env = envWithClients([]);
		const t0 = Date.now();

		const first = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "missing-record", client_id: "client-miss" },
			"server-miss",
		);
		expect(first).toBeNull();

		// Within the short TTL the miss is served from cache (no extra fetch).
		const second = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "missing-record", client_id: "client-miss" },
			"server-miss",
		);
		expect(second).toBeNull();
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);

		// Past the ~20s miss TTL the client is looked up again (tolerates the
		// Descope create→search propagation race).
		vi.spyOn(Date, "now").mockReturnValue(t0 + 21_000);
		await resolveAihM2mClientScopeContext(
			env,
			{ sub: "missing-record", client_id: "client-miss" },
			"server-miss",
		);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps hits cached past the short miss TTL (full 5-minute TTL)", async () => {
		const env = envWithClients([
			{
				id: "client-record-hit",
				clientId: "client-hit",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:observe"],
				tags: ["tedi:tedi-hit", "app:tedix-unified"],
			},
		]);
		const t0 = Date.now();

		const first = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-hit", client_id: "client-hit" },
			"server-hit",
		);
		expect(first?.clientRecordId).toBe("client-record-hit");

		vi.spyOn(Date, "now").mockReturnValue(t0 + 21_000);
		const second = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-hit", client_id: "client-hit" },
			"server-hit",
		);
		expect(second?.clientRecordId).toBe("client-record-hit");
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);
	});

	it("trusts one-run CI release-smoke AIH clients", async () => {
		const env = envWithClients([
			{
				id: "client-record-4",
				clientId: "client-4",
				name: "Tedix CI release smoke",
				scopes: ["platform:admin"],
				tags: ["ci:release-smoke", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-4", client_id: "client-4" },
			"server-4",
		);

		expect(result?.clientRecordId).toBe("client-record-4");
		expect(result?.scopes).toEqual(["platform:admin"]);
	});

	// Defense in depth (audit CC-2): a client-credentials token bypasses Descope
	// policies, so the registered client's baked scopes are its only Descope-side
	// boundary. If a capability DOWNGRADE has not yet propagated to the client
	// registration, the baked scopes are stale-broad. Bounding them to the live
	// D1 profile at request time ensures the resolved context can never advertise
	// more than the tedi's current profile.
	it("bounds a stale-broad tedi client's scopes to the live D1 profile", async () => {
		const env = envWithClients([
			{
				id: "client-record-dg",
				clientId: "client-dg",
				name: "tedi:cto (M2M)",
				// Baked at the old, broader profile (includes platform:admin/mcp:settings).
				scopes: ["mcp:memory", "mcp:settings", "platform:admin"],
				tags: ["tedi:tedi-dg", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-dg", client_id: "client-dg" },
			"server-dg",
			{
				// Live profile was downgraded to just mcp:memory.
				resolveTediProfileScopes: async (tediId) => {
					expect(tediId).toBe("tedi-dg");
					return ["mcp:memory"];
				},
			},
		);

		// Intersection: only the scope present in both survives.
		expect(result?.scopes).toEqual(["mcp:memory"]);
		expect(result?.tediId).toBe("tedi-dg");
		expect(result?.tediProfileScopes).toEqual(["mcp:memory"]);
	});

	it("is a no-op when the client scopes already equal the live profile", async () => {
		const env = envWithClients([
			{
				id: "client-record-eq",
				clientId: "client-eq",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory", "mcp:observe"],
				tags: ["tedi:tedi-eq", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-eq", client_id: "client-eq" },
			"server-eq",
			{
				resolveTediProfileScopes: async () => ["mcp:observe", "mcp:memory"],
			},
		);

		expect(result?.scopes).toEqual(["mcp:memory", "mcp:observe"]);
	});

	it("does not widen a server client's narrow grant from a broader live profile", async () => {
		const env = envWithClients([
			{
				id: "client-record-narrow",
				clientId: "client-narrow",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory"],
				tags: ["tedi:tedi-narrow", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-narrow", client_id: "client-narrow" },
			"server-narrow",
			{
				resolveTediProfileScopes: async () => ["mcp:memory", "mcp:settings"],
			},
		);

		expect(result?.scopes).toEqual(["mcp:memory"]);
	});

	it("leaves baked scopes intact when the live profile cannot be resolved", async () => {
		const env = envWithClients([
			{
				id: "client-record-null",
				clientId: "client-null",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory", "platform:admin"],
				tags: ["tedi:tedi-null", "app:tedix-unified"],
			},
		]);

		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-null", client_id: "client-null" },
			"server-null",
			{
				// Transient profile-lookup failure — must not strip a legitimate tedi.
				resolveTediProfileScopes: async () => null,
			},
		);

		expect(result?.scopes).toEqual(["mcp:memory", "platform:admin"]);
		expect(result?.tediProfileScopes).toBeUndefined();
	});

	it("applies the intersection at request time even when the client lookup is cache-served", async () => {
		const env = envWithClients([
			{
				id: "client-record-cache",
				clientId: "client-cache",
				name: "tedi:cto (M2M)",
				scopes: ["mcp:memory", "mcp:settings", "platform:admin"],
				tags: ["tedi:tedi-cache", "app:tedix-unified"],
			},
		]);

		// Prime the cache with a broad live profile.
		const first = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-cache", client_id: "client-cache" },
			"server-cache",
			{ resolveTediProfileScopes: async () => ["mcp:memory", "mcp:settings"] },
		);
		expect(first?.scopes).toEqual(["mcp:memory", "mcp:settings"]);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);

		// Profile downgraded. The client lookup is still cache-served (no extra
		// fetch), but the fresh profile is intersected at request time.
		const second = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-cache", client_id: "client-cache" },
			"server-cache",
			{ resolveTediProfileScopes: async () => ["mcp:memory"] },
		);
		expect(second?.scopes).toEqual(["mcp:memory"]);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not intersect a non-tedi (CI release-smoke) client", async () => {
		const env = envWithClients([
			{
				id: "client-record-ci",
				clientId: "client-ci",
				name: "Tedix CI release smoke",
				scopes: ["platform:admin"],
				tags: ["ci:release-smoke", "app:tedix-unified"],
			},
		]);

		let resolverCalled = false;
		const result = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-ci", client_id: "client-ci" },
			"server-ci",
			{
				resolveTediProfileScopes: async () => {
					resolverCalled = true;
					return ["mcp:memory"];
				},
			},
		);

		// A CI client has no D1 capability profile; its registration is the sole
		// authority and must not be narrowed by a tedi-profile resolver.
		expect(result?.scopes).toEqual(["platform:admin"]);
		expect(result?.tediId).toBeUndefined();
		expect(resolverCalled).toBe(false);
	});

	// Cross-server isolation regression: an AIH M2M client is registered under
	// exactly one mcpServerId. A client registered under server A must not be
	// honored when its credential is presented against server B — the per-server
	// Descope search that backs the lookup never returns another server's client.
	it("rejects a client registered under a DIFFERENT mcpServerId (cross-server isolation)", async () => {
		const registeredServerId = "server-registered";
		const clientRecord = {
			id: "client-record-xserver",
			clientId: "client-xserver",
			name: "tedi:cto (M2M)",
			scopes: ["platform:admin"],
			tags: ["tedi:tedi-xserver", "app:tedix-unified"],
		};
		// The mock models Descope's per-server search: it only returns the client
		// when the searched mcpServerId is the one the client was registered under.
		const fetch = vi.fn(async (request: Request) => {
			const body = await request.clone().text();
			const clients = body.includes(registeredServerId) ? [clientRecord] : [];
			return new Response(JSON.stringify({ json: { clients } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const env = {
			DESCOPE_PROJECT_ID: `project-${crypto.randomUUID()}`,
			API_SERVICE: { fetch },
		} as unknown as CloudflareEnv & { API_SERVICE: { fetch: typeof fetch } };

		// Presented against its own server → resolved.
		const sameServer = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-xserver", client_id: "client-xserver" },
			registeredServerId,
		);
		expect(sameServer?.clientRecordId).toBe("client-record-xserver");

		// Presented against a different server → rejected (no match).
		const otherServer = await resolveAihM2mClientScopeContext(
			env,
			{ sub: "client-record-xserver", client_id: "client-xserver" },
			"server-attacker",
		);
		expect(otherServer).toBeNull();
	});
});

describe("intersectScopes", () => {
	it("does not turn read or admin profile authority into execution authority", () => {
		expect(
			intersectScopes(["connections.execute"], ["connections.read"]),
		).toEqual([]);
		expect(
			intersectScopes(["connections.read"], ["connections.admin"]),
		).toEqual([]);
		expect(
			intersectScopes(["connections.admin"], ["connections.execute"]),
		).toEqual([]);
	});
	it("keeps the observer's provider read grant through the live worker profile ceiling", () => {
		const scopes = intersectScopes(
			["connections.read"],
			resolveTediScopes("standard"),
		);
		expect(hasScope(scopes, "connections.read")).toBe(true);
		expect(hasScope(scopes, "connections.execute")).toBe(false);
		expect(hasScope(scopes, "connections.admin")).toBe(false);
	});

	it("returns the subset present in both sets", () => {
		expect(
			intersectScopes(
				["mcp:memory", "mcp:settings", "platform:admin"],
				["mcp:memory", "mcp:observe"],
			),
		).toEqual(["mcp:memory"]);
	});

	it("is a no-op when the client scopes equal the profile scopes", () => {
		const client = ["mcp:memory", "mcp:observe"];
		expect(intersectScopes(client, ["mcp:observe", "mcp:memory"])).toEqual(
			client,
		);
	});

	it("returns empty when the sets are disjoint", () => {
		expect(intersectScopes(["platform:admin"], ["mcp:memory"])).toEqual([]);
	});

	it("preserves client order and de-duplicates", () => {
		expect(
			intersectScopes(
				["mcp:observe", "mcp:memory", "mcp:observe"],
				["mcp:memory", "mcp:observe"],
			),
		).toEqual(["mcp:observe", "mcp:memory"]);
	});

	it("can only narrow — a client scope absent from the profile is dropped", () => {
		expect(
			intersectScopes(["mcp:memory", "platform:admin"], ["mcp:memory"]),
		).toEqual(["mcp:memory"]);
	});
});

describe("resolveExternalAgentSessionAuth", () => {
	it("accepts only the exact canonical active identity returned by API", async () => {
		const identity = {
			organizationId: "00000000-0000-4000-8000-000000000001",
			principalId: "00000000-0000-4000-8000-000000000002",
			sessionId: "00000000-0000-4000-8000-000000000003",
		};
		let capturedRequest: Request | undefined;
		const fetch = vi.fn(async (request: Request) => {
			capturedRequest = request;
			return new Response(
				JSON.stringify({
					json: {
						principal: {
							id: identity.principalId,
							organizationId: identity.organizationId,
							key: "codex",
							displayName: "Codex",
							status: "active",
						},
						session: {
							id: identity.sessionId,
							organizationId: identity.organizationId,
							principalId: identity.principalId,
							harness: "codex",
							harnessVersion: "1",
							modelProvider: "openai",
							modelId: "gpt-5",
							modelVersion: "1",
							identitySource: "explicit",
							status: "active",
							creditEligible: true,
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const result = await resolveExternalAgentSessionAuth(
			{ API_SERVICE: { fetch } } as unknown as CloudflareEnv,
			identity,
			"aih-client-record-1",
		);
		expect(result.session.harness).toBe("codex");
		expect(fetch).toHaveBeenCalledWith(
			expect.objectContaining({ method: "POST" }),
		);
		expect(capturedRequest).toBeDefined();
		await expect(capturedRequest!.json()).resolves.toMatchObject({
			json: { clientRecordId: "aih-client-record-1" },
		});
	});
});

describe("request-level reviewed provider read scopes", () => {
	it("resolves the same authority as native and Code Mode dispatch", async () => {
		const tool = {
			toolId: "vendor__get_record",
			writeCapability: "read",
			config: {
				auth: { type: "connection", connectionId: "vendor" },
				connectionReadOnly: true,
			},
		} as unknown as AppTool;
		const request = () =>
			new Request("https://vendor.mcp.tedix.dev/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: tool.toolId, arguments: {} },
				}),
			});
		expect(await extractRequiredScopes(request(), undefined, [tool])).toEqual([
			"connections.read",
		]);
		expect(
			await extractRequiredScopes(request(), undefined, [
				{ ...tool, writeCapability: "write" },
			]),
		).toEqual(["connections.execute"]);
	});
});
