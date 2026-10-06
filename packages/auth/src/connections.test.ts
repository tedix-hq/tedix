import { fetchNamedTenantConnectionToken } from "./connections";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	discoverMcpConnectionProvider,
	exchangeCimdAuthorizationCode,
	ConnectionTokenLookupError,
	fetchConnectionToken,
	fetchPersonalConnectionToken,
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
	fetchConnectionTokenByScopes,
	getAdaptiveConnectUrl,
	listUserConnectedAppIds,
	updateConnectionProviderMetadataWithId,
	uploadTenantApiKeyToken,
	uploadTenantOAuthToken,
	uploadUserApiKeyToken,
	upsertConnectionProviderWithId,
} from "./connections.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("native Descope personal account selection", () => {
	it("never serves a named grant as the legacy default account", async () => {
		const response = {
			ok: true,
			data: {
				id: "named",
				accessToken: "opaque",
				externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
				scopes: ["Mail.Read"],
			},
		};
		const client = {
			management: {
				outboundApplication: {
					fetchToken: vi.fn(async () => response),
					fetchTokenByScopes: vi.fn(async () => response),
				},
			},
		} as unknown as Parameters<typeof fetchConnectionToken>[0];
		expect(await fetchConnectionToken(client, "provider", "user")).toBeNull();
		expect(
			await fetchConnectionTokenByScopes(client, "provider", "user", [
				"Mail.Read",
			]),
		).toBeNull();
	});
	const env = {
		DESCOPE_PROJECT_ID: "project",
		DESCOPE_MANAGEMENT_KEY: "management-key",
		DESCOPE_BASE_URL: "https://descope.example.com",
	};
	const selection = {
		appId: "provider",
		userId: "user",
		externalIdentifier: "slot-a",
	};
	const grant = {
		id: "token-a",
		...selection,
		accessToken: "secret",
		scopes: ["Calendars.Read"],
		tokenSub: "microsoft-account-a",
	};

	it("uses the native REST selector and never requests refresh tokens or tenant ownership", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ token: grant }));
		expect(await fetchPersonalConnectionToken(env, selection)).toMatchObject({
			id: "token-a",
			externalIdentifier: "slot-a",
			tokenSub: "microsoft-account-a",
		});
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(
			"https://descope.example.com/v1/mgmt/outbound/app/user/token/latest",
		);
		expect(JSON.parse(String(init?.body))).toEqual({
			...selection,
			options: { withRefreshToken: false, forceRefresh: false },
		});
	});

	it("pins named tenant lookups across scoped fallback", async () => {
		const tenantSelection = {
			appId: "provider",
			tenantId: "org_a",
			externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
		};
		const tenantGrant = { ...grant, ...tenantSelection, userId: undefined };
		const mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({}, 404))
			.mockResolvedValueOnce(jsonResponse({ token: tenantGrant }));
		expect(
			await fetchNamedTenantConnectionToken(env, {
				...tenantSelection,
				scopes: ["Calendars.Read"],
			}),
		).toMatchObject({ id: "token-a" });
		expect(mock.mock.calls.map(([url]) => url)).toEqual([
			"https://descope.example.com/v1/mgmt/outbound/app/tenant/token",
			"https://descope.example.com/v1/mgmt/outbound/app/tenant/token/latest",
		]);
		for (const [, init] of mock.mock.calls)
			expect(JSON.parse(String(init?.body))).toMatchObject(tenantSelection);
		mock
			.mockReset()
			.mockResolvedValue(
				jsonResponse({ token: { ...tenantGrant, tenantId: "org_b" } }),
			);
		await expect(
			fetchNamedTenantConnectionToken(env, tenantSelection),
		).rejects.toThrow();
	});

	it("keeps default and named tenant accounts independently addressable", async () => {
		const tenantSelection = {
			appId: "provider",
			tenantId: "org_a",
			externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
		};
		const client = {
			management: {
				outboundApplication: {
					fetchTenantToken: vi.fn(async () => ({
						ok: true,
						data: {
							id: "default",
							accessToken: "default-token",
							scopes: ["Calendars.Read"],
						},
					})),
				},
			},
		} as unknown as Parameters<typeof fetchTenantConnectionToken>[0];
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				token: {
					...grant,
					...tenantSelection,
					userId: undefined,
					accessToken: "named-token",
				},
			}),
		);
		expect(
			(await fetchTenantConnectionToken(client, "provider", "org_a"))
				?.accessToken,
		).toBe("default-token");
		expect(
			(await fetchNamedTenantConnectionToken(env, tenantSelection))
				?.accessToken,
		).toBe("named-token");
		expect(
			(await fetchTenantConnectionToken(client, "provider", "org_a"))
				?.accessToken,
		).toBe("default-token");
	});
	it("preserves upstream identifiers on default tenant grants, but refuses Tedix slots", async () => {
		const fetchTenantToken = vi.fn(async () => ({
			ok: true,
			data: {
				id: "legacy",
				accessToken: "opaque",
				externalIdentifier: "upstream-org",
			},
		}));
		const client = {
			management: { outboundApplication: { fetchTenantToken } },
		} as unknown as Parameters<typeof fetchTenantConnectionToken>[0];
		expect(
			await fetchTenantConnectionToken(client, "provider", "org_a"),
		).toMatchObject({ id: "legacy" });
		fetchTenantToken.mockResolvedValue({
			ok: true,
			data: {
				id: "named",
				accessToken: "opaque",
				externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
			},
		});
		expect(
			await fetchTenantConnectionToken(client, "provider", "org_a"),
		).toBeNull();
	});
	it("preserves the same selector on broader-scope fallback", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({}, 404))
			.mockResolvedValueOnce(jsonResponse({ token: grant }));
		expect(
			await fetchPersonalConnectionToken(env, {
				...selection,
				scopes: ["Calendars.Read"],
			}),
		).not.toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://descope.example.com/v1/mgmt/outbound/app/user/token",
			"https://descope.example.com/v1/mgmt/outbound/app/user/token/latest",
		]);
		for (const [, init] of fetchMock.mock.calls)
			expect(JSON.parse(String(init?.body)).externalIdentifier).toBe("slot-a");
	});
	it("normalizes native decimal-string expiries", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ token: { ...grant, accessTokenExpiry: "1900000000" } }),
		);
		expect(
			(await fetchPersonalConnectionToken(env, selection))?.expiresAt,
		).toBe(1900000000);
	});

	it.each([
		{ externalIdentifier: "slot-b" },
		{ externalIdentifier: undefined },
		{ userId: "another-user" },
		{ appId: "another-provider" },
		{ tenantId: "org" },
		{ id: "" },
		{ tokenSub: null },
		{ tokenSub: 123 },
		{ tokenSub: {} },
		{ scopes: [123] },
	])("rejects mismatched or malformed grants: %j", async (mismatch) => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ token: { ...grant, ...mismatch } }));
		await expect(
			fetchPersonalConnectionToken(env, selection),
		).rejects.toBeInstanceOf(ConnectionTokenLookupError);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([undefined, ""])(
		"accepts native subjectless grants in both scopes: %j",
		async (tokenSub) => {
			const fetchMock = vi.spyOn(globalThis, "fetch");
			fetchMock.mockResolvedValue(
				jsonResponse({ token: { ...grant, tokenSub } }),
			);
			const personal = await fetchPersonalConnectionToken(env, {
				...selection,
				scopes: ["Calendars.Read"],
			});
			expect(personal).toMatchObject({
				id: grant.id,
				accessToken: grant.accessToken,
			});
			expect(personal).not.toHaveProperty("tokenSub");
			const tenantSelection = {
				appId: "provider",
				tenantId: "org_a",
				externalIdentifier: "slot-a",
			};
			fetchMock.mockResolvedValue(
				jsonResponse({
					token: {
						...grant,
						...tenantSelection,
						userId: undefined,
						tokenSub,
					},
				}),
			);
			const tenant = await fetchNamedTenantConnectionToken(env, {
				...tenantSelection,
				scopes: ["Calendars.Read"],
			});
			expect(tenant).toMatchObject({
				id: grant.id,
				accessToken: grant.accessToken,
			});
			expect(tenant).not.toHaveProperty("tokenSub");
		},
	);

	it("returns missing rather than selecting another account", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({}, 404));
		expect(await fetchPersonalConnectionToken(env, selection)).toBeNull();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects insufficient scopes in the selected grant", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ token: grant }),
		);
		expect(
			await fetchPersonalConnectionToken(env, {
				...selection,
				scopes: ["Mail.Read"],
			}),
		).toBeNull();
	});

	it("does not retain a sensitive upstream body on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ message: "secret-refresh-token" }, 403),
		);
		await expect(fetchPersonalConnectionToken(env, selection)).rejects.toThrow(
			"Connection credential lookup unavailable (upstream status 403, named_user_latest)",
		);
	});

	it("passes the selector on adaptive personal connect", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ url: "https://login.example.com" }));
		await getAdaptiveConnectUrl(
			"provider",
			"https://os.example.com/callback",
			env,
			"user-jwt",
			undefined,
			["Mail.Read"],
			"slot-a",
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
			appId: "provider",
			options: {
				redirectUrl: "https://os.example.com/callback",
				scopes: ["Mail.Read"],
				externalIdentifier: "slot-a",
			},
		});
	});
});

describe("Descope outbound-app SDK wrappers", () => {
	it("imports tenant OAuth tokens through the management API", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ id: "vault-token-1" }));

		await uploadTenantOAuthToken(
			{
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
				DESCOPE_BASE_URL: "https://descope.example.com",
			},
			{
				appId: "catalog-provider",
				tenantId: "org_tedix",
				accessToken: "access-secret",
				refreshToken: "refresh-secret",
				accessTokenExpiry: 1_900_000_000,
				accessTokenType: "DPoP",
				scopes: ["mcp:tools"],
				externalIdentifier: "upstream-org",
				idToken: "id-secret",
				grantedBy: "user_1",
				verifyRefresh: true,
			},
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(
			"https://descope.example.com/v1/mgmt/outbound/app/tenant/oauthtoken/upload",
		);
		expect(init?.headers).toEqual({
			Authorization: "Bearer project:management-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			appId: "catalog-provider",
			tenantId: "org_tedix",
			accessToken: "access-secret",
			refreshToken: "refresh-secret",
			accessTokenExpiry: 1_900_000_000,
			accessTokenType: "DPoP",
			scopes: ["mcp:tools"],
			externalIdentifier: "upstream-org",
			idToken: "id-secret",
			grantedBy: "user_1",
			verifyRefresh: true,
		});
	});

	it("rejects malformed tenant OAuth grants before vault upload", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(
			uploadTenantOAuthToken(
				{
					DESCOPE_PROJECT_ID: "project",
					DESCOPE_MANAGEMENT_KEY: "management-key",
				},
				{
					appId: "provider",
					tenantId: "org_tedix",
					accessToken: "token",
					accessTokenExpiry: 0,
					grantedBy: "user_1",
				},
			),
		).rejects.toThrow("accessTokenExpiry must be positive Unix seconds");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("omits an empty scope list when importing a tenant OAuth token", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ id: "vault-token-1" }));

		await uploadTenantOAuthToken(
			{
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
				DESCOPE_BASE_URL: "https://descope.example.com",
			},
			{
				appId: "catalog-provider",
				tenantId: "org_tedix",
				accessToken: "access-secret",
				scopes: [],
				grantedBy: "user_1",
			},
		);

		const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
		expect(body).not.toHaveProperty("scopes");
	});

	it("uploads user API keys through the Descope SDK", async () => {
		const uploadUserApiKey = vi.fn().mockResolvedValue({ ok: true });
		const client = {
			management: { outboundApplication: { uploadUserApiKey } },
		} as unknown as Parameters<typeof uploadUserApiKeyToken>[0];

		await uploadUserApiKeyToken(client, {
			appId: "promptwatch-api-key",
			userId: "user_1",
			tenantId: "tenant_1",
			apiKey: "pw_project:pw_key",
		});

		expect(uploadUserApiKey).toHaveBeenCalledWith(
			"promptwatch-api-key",
			"user_1",
			"pw_project:pw_key",
			"tenant_1",
		);
	});

	it("uploads tenant API keys through the Descope SDK", async () => {
		const uploadTenantApiKey = vi.fn().mockResolvedValue({ ok: true });
		const client = {
			management: { outboundApplication: { uploadTenantApiKey } },
		} as unknown as Parameters<typeof uploadTenantApiKeyToken>[0];

		await uploadTenantApiKeyToken(client, {
			appId: "firecrawl-api-key",
			tenantId: "tenant_1",
			apiKey: "fc_project:fc_key",
		});

		expect(uploadTenantApiKey).toHaveBeenCalledWith(
			"firecrawl-api-key",
			"tenant_1",
			"fc_project:fc_key",
		);
	});

	it("lists connected user app ids and returns null on Descope failure", async () => {
		const listAppsWithUserToken = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, data: ["gmail", "calendar"] })
			.mockResolvedValueOnce({ ok: false, error: "unavailable" });
		const client = {
			management: { outboundApplication: { listAppsWithUserToken } },
		} as unknown as Parameters<typeof listUserConnectedAppIds>[0];

		await expect(listUserConnectedAppIds(client, "user_1")).resolves.toEqual(
			new Set(["gmail", "calendar"]),
		);
		await expect(listUserConnectedAppIds(client, "user_1")).resolves.toBeNull();
		expect(listAppsWithUserToken).toHaveBeenCalledWith("user_1");
	});

	it("throws when SDK API-key upload fails", async () => {
		const client = {
			management: {
				outboundApplication: {
					uploadUserApiKey: vi
						.fn()
						.mockResolvedValue({ ok: false, error: "denied" }),
				},
			},
		} as unknown as Parameters<typeof uploadUserApiKeyToken>[0];

		await expect(
			uploadUserApiKeyToken(client, {
				appId: "provider",
				userId: "user_1",
				apiKey: "secret",
			}),
		).rejects.toThrow(
			"Descope outbound app user API key upload failed: denied",
		);
	});
});

describe("CIMD authorization-code exchange", () => {
	it("binds PKCE, client, redirect, and RFC 8707 resource", async () => {
		let requestBody = "";
		const result = await exchangeCimdAuthorizationCode(
			{
				tokenUrl: "https://auth.example.com/token",
				code: "authorization-code",
				codeVerifier: "v".repeat(43),
				resource: "https://mcp.example.com/mcp",
				redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
				clientId:
					"https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json",
			},
			async (_input, init) => {
				requestBody = String(init?.body);
				return jsonResponse({
					access_token: "access-secret",
					refresh_token: "refresh-secret",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "mcp:tools profile",
				});
			},
		);

		expect(Object.fromEntries(new URLSearchParams(requestBody))).toEqual({
			grant_type: "authorization_code",
			code: "authorization-code",
			code_verifier: "v".repeat(43),
			resource: "https://mcp.example.com/mcp",
			redirect_uri: "https://api.tedix.dev/oauth/mcp/callback",
			client_id:
				"https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json",
		});
		expect(result).toMatchObject({
			accessToken: "access-secret",
			refreshToken: "refresh-secret",
			accessTokenType: "Bearer",
			scopes: ["mcp:tools", "profile"],
		});
	});

	it("does not expose an upstream token error body", async () => {
		const failed = exchangeCimdAuthorizationCode(
			{
				tokenUrl: "https://auth.example.com/token",
				code: "bad",
				codeVerifier: "v".repeat(43),
				resource: "https://mcp.example.com/mcp",
				redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
				clientId: "client",
			},
			async () =>
				jsonResponse(
					{ error: "invalid_grant", error_description: "secret detail" },
					400,
				),
		);
		await expect(failed).rejects.toThrow(
			"OAuth token exchange failed (HTTP 400)",
		);
		await expect(failed).rejects.not.toThrow(/secret detail|invalid_grant/);
	});

	it.each([307, 308])(
		"never forwards the authorization code through a %i redirect",
		async (status) => {
			const fetchFn = vi.fn(
				async (_input: string, _init?: RequestInit) =>
					new Response(null, {
						status,
						headers: { Location: "https://other.example.com/token" },
					}),
			);
			await expect(
				exchangeCimdAuthorizationCode(
					{
						tokenUrl: "https://auth.example.com/token",
						code: "authorization-code",
						codeVerifier: "v".repeat(43),
						resource: "https://mcp.example.com/mcp",
						redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
						clientId: "client",
					},
					fetchFn,
				),
			).rejects.toThrow("OAuth token endpoint request failed");
			expect(fetchFn).toHaveBeenCalledOnce();
			expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe("manual");
		},
	);

	it("bounds token response bytes even when Content-Length is absent", async () => {
		await expect(
			exchangeCimdAuthorizationCode(
				{
					tokenUrl: "https://auth.example.com/token",
					code: "code",
					codeVerifier: "v".repeat(43),
					resource: "https://mcp.example.com/mcp",
					redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
					clientId: "client",
				},
				async () => new Response("x".repeat(64 * 1024 + 1)),
			),
		).rejects.toThrow("OAuth token endpoint response is too large");
	});

	it("aborts a stalled token request at the deadline", async () => {
		vi.useFakeTimers();
		try {
			const pending = exchangeCimdAuthorizationCode(
				{
					tokenUrl: "https://auth.example.com/token",
					code: "code",
					codeVerifier: "v".repeat(43),
					resource: "https://mcp.example.com/mcp",
					redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
					clientId: "client",
				},
				async (_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(new Error("secret request detail")),
						);
					}),
			);
			const assertion = expect(pending).rejects.toThrow(
				"OAuth token exchange timed out",
			);
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels a stalled token response stream at the deadline", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		try {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('{"access_token":"partial'),
					);
				},
				cancel,
			});
			const pending = exchangeCimdAuthorizationCode(
				{
					tokenUrl: "https://auth.example.com/token",
					code: "code",
					codeVerifier: "v".repeat(43),
					resource: "https://mcp.example.com/mcp",
					redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
					clientId: "client",
				},
				async () => new Response(body),
			);
			const assertion = expect(pending).rejects.toThrow(
				"OAuth token exchange timed out",
			);
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
			expect(cancel).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("getAdaptiveConnectUrl", () => {
	it("forwards explicit scopes inside Descope connect options", async () => {
		const requests: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body ?? "{}")));
			return jsonResponse({ url: "https://accounts.example.com/consent" });
		});

		await expect(
			getAdaptiveConnectUrl(
				"google-gmail",
				"https://acme.os.tedix.dev/oauth/callback",
				{ DESCOPE_PROJECT_ID: "project" },
				"user.jwt.token",
				undefined,
				["gmail.readonly", "gmail.modify"],
			),
		).resolves.toEqual({ url: "https://accounts.example.com/consent" });
		expect(requests).toEqual([
			{
				appId: "google-gmail",
				options: {
					redirectUrl: "https://acme.os.tedix.dev/oauth/callback",
					scopes: ["gmail.readonly", "gmail.modify"],
				},
			},
		]);
	});
});

describe("discoverMcpConnectionProvider", () => {
	it("derives Descope DCR config from MCP protected-resource metadata", async () => {
		const seen: string[] = [];
		const fetchFn = async (url: string) => {
			seen.push(url);
			if (
				url ===
				"https://ai.todoist.net/.well-known/oauth-protected-resource/mcp"
			) {
				return jsonResponse({ error: "not found" }, 404);
			}
			if (
				url === "https://ai.todoist.net/.well-known/oauth-protected-resource"
			) {
				return jsonResponse({
					resource: "https://ai.todoist.net/mcp",
					authorization_servers: ["https://todoist.com"],
					scopes_supported: ["data:read_write"],
				});
			}
			if (
				url === "https://todoist.com/.well-known/oauth-authorization-server"
			) {
				return jsonResponse({
					issuer: "https://todoist.com",
					authorization_endpoint: "https://todoist.com/oauth/authorize",
					token_endpoint: "https://todoist.com/oauth/access_token",
					revocation_endpoint: "https://todoist.com/api/v1/revoke",
					registration_endpoint: "https://todoist.com/oauth/register",
					scopes_supported: ["data:read", "data:read_write"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					authorization_response_iss_parameter_supported: true,
				});
			}
			return jsonResponse({ error: "unexpected" }, 404);
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://ai.todoist.net/mcp",
				name: "Todoist",
			},
			fetchFn,
		);

		expect(seen).toEqual([
			"https://ai.todoist.net/.well-known/oauth-protected-resource/mcp",
			"https://ai.todoist.net/.well-known/oauth-protected-resource",
			"https://todoist.com/.well-known/oauth-authorization-server",
		]);
		expect(result.config).toMatchObject({
			name: "Todoist",
			authorizationUrl: "https://todoist.com/oauth/authorize",
			tokenUrl: "https://todoist.com/oauth/access_token",
			revocationUrl: "https://todoist.com/api/v1/revoke",
			useDcr: true,
			dcrUrl: "https://todoist.com/oauth/register",
			pkce: true,
			defaultScopes: ["data:read_write"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://ai.todoist.net/mcp" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://ai.todoist.net/mcp" },
			],
		});
		expect(result.discovery.dcrUrl).toBe("https://todoist.com/oauth/register");
		expect(result.discovery.mcpEndpointUrl).toBe("https://ai.todoist.net/mcp");
		expect(result.discovery.authorizationResponseIssParameterSupported).toBe(
			true,
		);
		expect(result.discovery.registrationMode).toBe("dcr");
		expect(result.discovery.clientIdMetadataDocumentSupported).toBe(false);
	});

	it("selects CIMD without requiring a DCR endpoint", async () => {
		const fetchFn = async (url: string) => {
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({
					resource: "https://mcp.example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["messages:read"],
				});
			}
			if (url.includes("oauth-authorization-server")) {
				return jsonResponse({
					issuer: "https://auth.example.com",
					authorization_endpoint: "https://auth.example.com/authorize",
					token_endpoint: "https://auth.example.com/token",
					client_id_metadata_document_supported: true,
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			}
			return jsonResponse({ error: "unexpected" }, 404);
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://mcp.example.com/mcp",
				name: "CIMD Provider",
			},
			fetchFn,
		);

		expect(result.config).toMatchObject({
			clientId: "https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json",
			useDcr: false,
			pkce: true,
		});
		expect(result.config.dcrUrl).toBeUndefined();
		expect(result.discovery).toMatchObject({
			registrationMode: "cimd",
			clientIdMetadataDocumentSupported: true,
			dcrUrl: null,
		});
	});

	it("discovers Cloudflare Access protected-resource metadata", async () => {
		const seen: string[] = [];
		const fetchFn = async (url: string) => {
			seen.push(url);
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			if (
				url ===
				"https://api.example.com/.well-known/cloudflare-access-protected-resource/api/v1/identity/me"
			) {
				return jsonResponse({
					resource: "https://api.example.com/api/v1/identity/me",
					authorization_servers: ["https://team.cloudflareaccess.com"],
				});
			}
			if (
				url ===
				"https://team.cloudflareaccess.com/.well-known/oauth-authorization-server"
			) {
				return jsonResponse({
					issuer: "https://team.cloudflareaccess.com",
					authorization_endpoint:
						"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
					token_endpoint:
						"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
					registration_endpoint:
						"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
					code_challenge_methods_supported: ["S256"],
				});
			}
			return jsonResponse({ error: "unexpected" }, 404);
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://api.example.com/api/v1/identity/me",
				name: "Example API",
			},
			fetchFn,
		);

		expect(seen).toEqual([
			"https://api.example.com/.well-known/oauth-protected-resource/api/v1/identity/me",
			"https://api.example.com/.well-known/oauth-protected-resource",
			"https://api.example.com/.well-known/cloudflare-access-protected-resource/api/v1/identity/me",
			"https://team.cloudflareaccess.com/.well-known/oauth-authorization-server",
		]);
		expect(result.config).toMatchObject({
			useDcr: true,
			dcrUrl:
				"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
			pkce: true,
			authorizationUrlParams: [
				{
					key: "resource",
					value: "https://api.example.com/api/v1/identity/me",
				},
			],
		});
	});

	it("rejects scopes not advertised by the MCP protected resource", async () => {
		const fetchFn = async (url: string) => {
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			return jsonResponse({
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
			});
		};

		await expect(
			discoverMcpConnectionProvider(
				{
					mcpEndpointUrl: "https://example.com/mcp",
					name: "Example",
					defaultScopes: ["write"],
				},
				fetchFn,
			),
		).rejects.toThrow(
			"Requested scopes are not advertised by the MCP protected resource: write",
		);
	});

	it("falls back to authorization-server scopes when protected-resource scopes are omitted", async () => {
		const fetchFn = async (url: string) => {
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({
					resource: "https://mcp.alpic.ai",
					authorization_servers: ["https://mcp.alpic.ai"],
				});
			}
			return jsonResponse({
				authorization_endpoint: "https://mcp.alpic.ai/oauth2/authorize",
				token_endpoint: "https://mcp.alpic.ai/oauth2/token",
				registration_endpoint: "https://mcp.alpic.ai/oauth2/register",
				scopes_supported: ["openid"],
			});
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://mcp.alpic.ai/",
				name: "Alpic",
			},
			fetchFn,
		);

		expect(result.config.defaultScopes).toEqual(["openid"]);
		expect(result.warnings).toEqual([]);
	});

	it("retries transient metadata failures", async () => {
		let authorizationServerAttempts = 0;
		const fetchFn = async (url: string) => {
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			authorizationServerAttempts += 1;
			if (authorizationServerAttempts === 1) {
				return jsonResponse({ error: "try again" }, 503);
			}
			return jsonResponse({
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
			});
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://example.com/mcp",
				name: "Example",
				defaultScopes: ["read"],
			},
			fetchFn,
		);

		expect(authorizationServerAttempts).toBe(2);
		expect(result.config.dcrUrl).toBe("https://auth.example.com/register");
	});

	it("falls back to RFC 8414 authorization-server metadata when protected-resource metadata 404s (Atlassian)", async () => {
		const seen: string[] = [];
		const fetchFn = async (url: string) => {
			seen.push(url);
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			if (
				url ===
				"https://mcp.atlassian.com/.well-known/oauth-authorization-server"
			) {
				return jsonResponse({
					issuer: "https://cf.mcp.atlassian.com",
					authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
					token_endpoint: "https://cf.mcp.atlassian.com/v1/token",
					registration_endpoint: "https://cf.mcp.atlassian.com/v1/register",
					code_challenge_methods_supported: ["plain", "S256"],
					grant_types_supported: ["authorization_code", "refresh_token"],
				});
			}
			return jsonResponse({ error: "unexpected" }, 404);
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://mcp.atlassian.com/v1/mcp",
				name: "Atlassian",
			},
			fetchFn,
		);

		expect(seen).toEqual([
			"https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp",
			"https://mcp.atlassian.com/.well-known/oauth-protected-resource",
			"https://mcp.atlassian.com/.well-known/cloudflare-access-protected-resource/v1/mcp",
			"https://mcp.atlassian.com/.well-known/cloudflare-access-protected-resource",
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server/v1/mcp",
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		]);
		expect(result.config).toMatchObject({
			name: "Atlassian",
			authorizationUrl: "https://mcp.atlassian.com/v1/authorize",
			tokenUrl: "https://cf.mcp.atlassian.com/v1/token",
			useDcr: true,
			dcrUrl: "https://cf.mcp.atlassian.com/v1/register",
			pkce: true,
		});
		expect(result.discovery.protectedResourceMetadataUrl).toBeNull();
		expect(result.discovery.resource).toBe("https://mcp.atlassian.com/v1/mcp");
		expect(result.discovery.authorizationServer).toBe(
			"https://cf.mcp.atlassian.com",
		);
		expect(result.discovery.authorizationServerMetadataUrl).toBe(
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		);
		expect(result.discovery.authorizationResponseIssParameterSupported).toBe(
			false,
		);
	});

	it("throws an informative error when both protected-resource and authorization-server metadata are unavailable", async () => {
		const fetchFn = async () => jsonResponse({ error: "not found" }, 404);

		await expect(
			discoverMcpConnectionProvider(
				{
					mcpEndpointUrl: "https://no-oauth.example.com/mcp",
					name: "No OAuth",
				},
				fetchFn,
			),
		).rejects.toThrow(
			/protected-resource metadata unavailable.*authorization-server metadata unavailable/s,
		);
	});

	it("records application_type web for the discovered confidential web client", async () => {
		const fetchFn = async (url: string) => {
			if (url === "https://example.com/.well-known/oauth-protected-resource") {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			return jsonResponse({
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				scopes_supported: ["read"],
				code_challenge_methods_supported: ["S256"],
			});
		};

		const result = await discoverMcpConnectionProvider(
			{ mcpEndpointUrl: "https://example.com/mcp", name: "Example" },
			fetchFn,
		);

		expect(result.config.applicationType).toBe("web");
		expect(result.config.useDcr).toBe(true);
	});

	it("accepts a matching authorization-server issuer (RFC 9207)", async () => {
		const fetchFn = async (url: string) => {
			if (url === "https://example.com/.well-known/oauth-protected-resource") {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			// Issuer advertised with a trailing slash; must still be accepted.
			return jsonResponse({
				issuer: "https://auth.example.com/",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				scopes_supported: ["read"],
			});
		};

		const result = await discoverMcpConnectionProvider(
			{ mcpEndpointUrl: "https://example.com/mcp", name: "Example" },
			fetchFn,
		);

		expect(result.discovery.authorizationServer).toBe(
			"https://auth.example.com/",
		);
	});

	it("preserves a host-only issuer exactly for RFC 9207 callback validation", async () => {
		const fetchFn = async (url: string) => {
			if (
				url ===
				"https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp"
			) {
				return jsonResponse({
					resource: "https://mcp.cloudflare.com/mcp",
					authorization_servers: ["https://mcp.cloudflare.com"],
				});
			}
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			return jsonResponse({
				issuer: "https://mcp.cloudflare.com",
				authorization_endpoint: "https://mcp.cloudflare.com/authorize",
				token_endpoint: "https://mcp.cloudflare.com/token",
				client_id_metadata_document_supported: true,
				authorization_response_iss_parameter_supported: true,
				code_challenge_methods_supported: ["S256"],
			});
		};

		const result = await discoverMcpConnectionProvider(
			{
				mcpEndpointUrl: "https://mcp.cloudflare.com/mcp",
				name: "Cloudflare",
			},
			fetchFn,
		);

		expect(result.discovery.authorizationServer).toBe(
			"https://mcp.cloudflare.com",
		);
		expect(result.discovery.authorizationResponseIssParameterSupported).toBe(
			true,
		);
	});

	it("rejects a mismatched authorization-server issuer (RFC 9207 mix-up defense)", async () => {
		const fetchFn = async (url: string) => {
			if (url === "https://example.com/.well-known/oauth-protected-resource") {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			// Mix-up: the metadata claims to be a different issuer than the one
			// the protected resource directed us to.
			return jsonResponse({
				issuer: "https://evil.attacker.example",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				scopes_supported: ["read"],
			});
		};

		await expect(
			discoverMcpConnectionProvider(
				{ mcpEndpointUrl: "https://example.com/mcp", name: "Example" },
				fetchFn,
			),
		).rejects.toThrow(/issuer mismatch/i);
	});

	it("treats an absent authorization-server issuer as a no-op (RFC 8414 issuer optional in practice)", async () => {
		const fetchFn = async (url: string) => {
			if (url === "https://example.com/.well-known/oauth-protected-resource") {
				return jsonResponse({
					resource: "https://example.com/mcp",
					authorization_servers: ["https://auth.example.com"],
					scopes_supported: ["read"],
				});
			}
			if (url.includes("oauth-protected-resource")) {
				return jsonResponse({ error: "not found" }, 404);
			}
			// No `issuer` field — nothing to cross-check, must not reject.
			return jsonResponse({
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				scopes_supported: ["read"],
			});
		};

		const result = await discoverMcpConnectionProvider(
			{ mcpEndpointUrl: "https://example.com/mcp", name: "Example" },
			fetchFn,
		);

		expect(result.config.authorizationUrl).toBe(
			"https://auth.example.com/authorize",
		);
	});
});

describe("upsertConnectionProviderWithId", () => {
	it("updates existing Descope OAuth apps when create reports persist failure", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				requests.push({ url, body });
				if (url.endsWith("/v1/mgmt/outbound/app/create")) {
					return jsonResponse(
						{
							errorCode: "E151001",
							errorDescription: "Failed to create OAuth application",
							errorMessage: "Failed to persist oauth app",
						},
						500,
					);
				}
				if (url.endsWith("/v1/mgmt/outbound/app/update")) {
					return jsonResponse({ app: { id: "peec" } });
				}
				return jsonResponse({ error: "unexpected" }, 404);
			},
		);

		const result = await upsertConnectionProviderWithId(
			"peec",
			{
				name: "Peec",
				type: "oauth",
				clientId: "registered-client",
				authorizationUrl: "https://api.peec.ai/mcp/authorize",
				tokenUrl: "https://api.peec.ai/mcp/token",
				useDcr: false,
			},
			{
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
			},
		);

		expect(result).toEqual({ id: "peec", status: "updated" });
		expect(requests.map((request) => request.url)).toEqual([
			"https://auth.tedix.dev/v1/mgmt/outbound/app/create",
			"https://auth.tedix.dev/v1/mgmt/outbound/app/update",
		]);
		expect(requests[1]?.body).toEqual({
			app: {
				id: "peec",
				name: "Peec",
				appType: "oauth",
				clientId: "registered-client",
				authorizationUrl: "https://api.peec.ai/mcp/authorize",
				tokenUrl: "https://api.peec.ai/mcp/token",
				useDcr: false,
			},
		});
	});
});

describe("updateConnectionProviderMetadataWithId", () => {
	it("preserves the existing outbound app shape and writes console-ready logos", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
		const expectedLogo = `data:image/svg+xml;base64,${btoa(svg)}`;
		const requests: Array<{
			method: string;
			url: string;
			body?: Record<string, unknown>;
		}> = [];

		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				requests.push({
					method,
					url,
					body: init?.body
						? (JSON.parse(String(init.body)) as Record<string, unknown>)
						: undefined,
				});

				if (
					url === "https://auth.tedix.dev/v1/mgmt/outbound/app/google-calendar"
				) {
					return jsonResponse({
						app: {
							id: "google-calendar",
							name: "Google Calendar",
							description: "Old description",
							appType: "oauth",
							clientId: "client_123",
							authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
							tokenUrl: "https://oauth2.googleapis.com/token",
							defaultScopes: ["openid", "email"],
							useDcr: false,
						},
					});
				}
				if (url === "https://example.com/calendar.svg") {
					return new Response(svg, {
						status: 200,
						headers: { "Content-Type": "image/svg+xml" },
					});
				}
				if (url === "https://auth.tedix.dev/v1/mgmt/outbound/app/update") {
					return jsonResponse({ app: { id: "google-calendar" } });
				}
				return jsonResponse({ error: "unexpected" }, 404);
			},
		);

		const result = await updateConnectionProviderMetadataWithId(
			"google-calendar",
			{
				description: "Updated description",
				logo: "https://example.com/calendar.svg",
				defaultScopes: ["calendar.events.readonly"],
			},
			{
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
			},
		);

		expect(result).toEqual({ id: "google-calendar" });
		expect(
			requests.map((request) => `${request.method} ${request.url}`),
		).toEqual([
			"GET https://auth.tedix.dev/v1/mgmt/outbound/app/google-calendar",
			"GET https://example.com/calendar.svg",
			"POST https://auth.tedix.dev/v1/mgmt/outbound/app/update",
		]);
		expect(requests[2]?.body).toEqual({
			app: {
				id: "google-calendar",
				name: "Google Calendar",
				description: "Updated description",
				appType: "oauth",
				clientId: "client_123",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				defaultScopes: ["calendar.events.readonly"],
				useDcr: false,
				logo: expectedLogo,
			},
		});
	});

	it("retries API-key metadata updates with the source URL when inline logo upload fails", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
		const requests: Array<{
			method: string;
			url: string;
			body?: Record<string, unknown>;
		}> = [];

		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const body = init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined;
				requests.push({ method, url, body });

				if (url === "https://auth.tedix.dev/v1/mgmt/outbound/app/promptwatch") {
					return jsonResponse({
						app: {
							id: "promptwatch",
							name: "PromptWatch",
							description: "Old description",
							clientId: "",
							authorizationUrl: "",
							tokenUrl: "",
							defaultScopes: [],
							appType: "apikey",
							useDcr: false,
						},
					});
				}
				if (url === "https://example.com/promptwatch.svg") {
					return new Response(svg, {
						status: 200,
						headers: { "Content-Type": "image/svg+xml" },
					});
				}
				if (url === "https://auth.tedix.dev/v1/mgmt/outbound/app/update") {
					const logo = (body?.app as { logo?: string } | undefined)?.logo;
					if (logo?.startsWith("data:image/")) {
						return jsonResponse(
							{
								errorCode: "E151002",
								errorMessage: "Failed to update oauth app",
							},
							500,
						);
					}
					return jsonResponse({ app: { id: "promptwatch" } });
				}
				return jsonResponse({ error: "unexpected" }, 404);
			},
		);

		const result = await updateConnectionProviderMetadataWithId(
			"promptwatch",
			{ logo: "https://example.com/promptwatch.svg" },
			{
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
			},
		);

		expect(result).toEqual({ id: "promptwatch" });
		expect(
			requests.map((request) => `${request.method} ${request.url}`),
		).toEqual([
			"GET https://auth.tedix.dev/v1/mgmt/outbound/app/promptwatch",
			"GET https://example.com/promptwatch.svg",
			"POST https://auth.tedix.dev/v1/mgmt/outbound/app/update",
			"POST https://auth.tedix.dev/v1/mgmt/outbound/app/update",
		]);
		expect(
			(
				requests[2]?.body?.app as { logo?: string } | undefined
			)?.logo?.startsWith("data:image/svg+xml;base64,"),
		).toBe(true);
		expect(
			(requests[3]?.body?.app as { logo?: string } | undefined)?.logo,
		).toBe("https://example.com/promptwatch.svg");
	});
});

describe("fetchConnectionTokenByScopes scope coverage", () => {
	function clientWithFallbackScopes(grantedScopes: string[]) {
		const fetchTokenByScopes = vi
			.fn()
			.mockResolvedValue({ ok: false, code: 404 });
		const fetchToken = vi.fn().mockResolvedValue({
			ok: true,
			data: {
				id: "tok_1",
				accessToken: "ya29.token",
				accessTokenExpiry: 0,
				scopes: grantedScopes,
			},
		});
		return {
			client: {
				management: { outboundApplication: { fetchTokenByScopes, fetchToken } },
			} as unknown as Parameters<typeof fetchConnectionTokenByScopes>[0],
			fetchTokenByScopes,
		};
	}

	it("accepts a broader write grant for a required .readonly scope", async () => {
		// Google issues `.../documents` when the app declared
		// `.../documents.readonly`; the strictly broader grant must satisfy it.
		const { client } = clientWithFallbackScopes([
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/documents",
		]);

		const token = await fetchConnectionTokenByScopes(
			client,
			"google-docs",
			"user_1",
			[
				"https://www.googleapis.com/auth/drive.readonly",
				"https://www.googleapis.com/auth/documents.readonly",
			],
		);

		expect(token?.accessToken).toBe("ya29.token");
	});

	it("still rejects a token missing the required scope family", async () => {
		const { client } = clientWithFallbackScopes([
			"https://www.googleapis.com/auth/drive.readonly",
		]);

		const token = await fetchConnectionTokenByScopes(
			client,
			"google-docs",
			"user_1",
			["https://www.googleapis.com/auth/documents.readonly"],
		);

		expect(token).toBeNull();
	});

	it("does not accept a narrower .readonly grant for a required write scope", async () => {
		const { client } = clientWithFallbackScopes([
			"https://www.googleapis.com/auth/documents.readonly",
		]);

		const token = await fetchConnectionTokenByScopes(
			client,
			"google-docs",
			"user_1",
			["https://www.googleapis.com/auth/documents"],
		);

		expect(token).toBeNull();
	});

	it("does not treat an unrelated scope sharing a prefix as coverage", async () => {
		const { client } = clientWithFallbackScopes([
			"https://www.googleapis.com/auth/documents.other",
		]);

		const token = await fetchConnectionTokenByScopes(
			client,
			"google-docs",
			"user_1",
			["https://www.googleapis.com/auth/documents.readonly"],
		);

		expect(token).toBeNull();
	});
});

describe("credential lookup failure preservation", () => {
	for (const [lookup, method] of [
		[fetchConnectionToken, "fetchToken"],
		[fetchTenantConnectionToken, "fetchTenantToken"],
	] as const) {
		it(`${method} distinguishes absence from restricted/unavailable without secrets`, async () => {
			for (const code of [401, 403, 429, 500, 503]) {
				const client = {
					management: {
						outboundApplication: {
							[method]: async () => ({
								ok: false,
								code,
								errorDescription: "Bearer secret",
							}),
						},
					},
				} as never;
				await expect(lookup(client, "provider", "owner")).rejects.toMatchObject(
					{ name: "ConnectionTokenLookupError", status: code },
				);
				await expect(lookup(client, "provider", "owner")).rejects.not.toThrow(
					"secret",
				);
			}
			const client = {
				management: {
					outboundApplication: {
						[method]: async () => ({ ok: false, code: 404 }),
					},
				},
			} as never;
			await expect(lookup(client, "provider", "owner")).resolves.toBeNull();
		});
		it(`${method} sanitizes thrown errors`, async () => {
			const client = {
				management: {
					outboundApplication: {
						[method]: async () => {
							throw Error("token secret");
						},
					},
				},
			} as never;
			await expect(lookup(client, "provider", "owner")).rejects.toThrow(
				ConnectionTokenLookupError,
			);
			await expect(lookup(client, "provider", "owner")).rejects.not.toThrow(
				"secret",
			);
		});
	}
	for (const [lookup, scoped, plain] of [
		[fetchConnectionTokenByScopes, "fetchTokenByScopes", "fetchToken"],
		[
			fetchTenantConnectionTokenByScopes,
			"fetchTenantTokenByScopes",
			"fetchTenantToken",
		],
	] as const) {
		it(`${scoped} allows validated fallback but retains failure when fallback is absent`, async () => {
			let found = true;
			const client = {
				management: {
					outboundApplication: {
						[scoped]: async () => ({ ok: false, code: 403 }),
						[plain]: async () =>
							found
								? {
										ok: true,
										data: { accessToken: "opaque", scopes: ["read"] },
									}
								: { ok: false, code: 404 },
					},
				},
			} as never;
			await expect(
				lookup(client, "provider", "owner", ["read"]),
			).resolves.toMatchObject({ accessToken: "opaque" });
			found = false;
			await expect(
				lookup(client, "provider", "owner", ["read"]),
			).rejects.toMatchObject({ status: 403 });
		});
	}
});

describe("safe credential lookup diagnostics", () => {
	const lookups = [
		{
			method: "fetchToken",
			kind: "user_latest",
			call: (client: never) =>
				fetchConnectionToken(client, "provider", "owner"),
		},
		{
			method: "fetchTenantToken",
			kind: "tenant_latest",
			call: (client: never) =>
				fetchTenantConnectionToken(client, "provider", "owner"),
		},
		{
			method: "fetchTokenByScopes",
			kind: "user_scoped",
			fallback: "fetchToken",
			call: (client: never) =>
				fetchConnectionTokenByScopes(client, "provider", "owner", ["read"]),
		},
		{
			method: "fetchTenantTokenByScopes",
			kind: "tenant_scoped",
			fallback: "fetchTenantToken",
			call: (client: never) =>
				fetchTenantConnectionTokenByScopes(client, "provider", "owner", [
					"read",
				]),
		},
	];
	it.each(lookups)(
		"retains only safe vendor code and $kind provenance",
		async ({ method, kind, fallback, call }) => {
			const client = {
				management: {
					outboundApplication: {
						[method]: async () => ({
							ok: false,
							code: 401,
							error: {
								errorCode: "E151002",
								errorDescription: "Bearer private-secret",
								errorMessage: "private-secret",
							},
						}),
						...(fallback
							? { [fallback]: async () => ({ ok: false, code: 404 }) }
							: {}),
					},
				},
			} as never;
			const error = await call(client).catch((e) => e);
			expect(error).toMatchObject({
				status: 401,
				lookupKind: kind,
				upstreamCode: "E151002",
			});
			expect(error.message).toBe(
				`Connection credential lookup unavailable (upstream status 401, ${kind}, E151002)`,
			);
			expect(JSON.stringify(error)).not.toContain("private-secret");
		},
	);
	it.each([
		"Bearer private-secret",
		"E151002\nprivate-secret",
		"E151002\n",
		"E151002extra",
		"E15100",
		null,
	])("omits non-vendor codes and messages", async (errorCode) => {
		const client = {
			management: {
				outboundApplication: {
					fetchToken: async () => ({
						ok: false,
						code: 403,
						error: { errorCode, errorMessage: "private-secret" },
					}),
				},
			},
		} as never;
		const error = await fetchConnectionToken(client, "provider", "owner").catch(
			(e) => e,
		);
		expect(error.upstreamCode).toBeUndefined();
		expect(error.message).toBe(
			"Connection credential lookup unavailable (upstream status 403, user_latest)",
		);
	});
	it.each(lookups)(
		"does not preserve a thrown cause for $kind",
		async ({ method, kind, fallback, call }) => {
			const client = {
				management: {
					outboundApplication: {
						[method]: async () => {
							throw Error("private-secret");
						},
						...(fallback
							? { [fallback]: async () => ({ ok: false, code: 404 }) }
							: {}),
					},
				},
			} as never;
			const error = await call(client).catch((e) => e);
			expect(error).toMatchObject({ lookupKind: kind });
			expect(error.message).not.toContain("private-secret");
			expect(error.cause).toBeUndefined();
		},
	);
	it.each([
		{
			scoped: fetchConnectionTokenByScopes,
			method: "fetchTokenByScopes",
			fallback: "fetchToken",
			kind: "user_latest",
		},
		{
			scoped: fetchTenantConnectionTokenByScopes,
			method: "fetchTenantTokenByScopes",
			fallback: "fetchTenantToken",
			kind: "tenant_latest",
		},
	])(
		"preserves the actual failing latest fallback ($kind)",
		async ({ scoped, method, fallback, kind }) => {
			const client = {
				management: {
					outboundApplication: {
						[method]: async () => ({ ok: false, code: 404 }),
						[fallback]: async () => ({
							ok: false,
							code: 401,
							error: { errorCode: "E151002" },
						}),
					},
				},
			} as never;
			const error = await scoped(client, "provider", "owner", ["read"]).catch(
				(e) => e,
			);
			expect(error).toMatchObject({
				status: 401,
				lookupKind: kind,
				upstreamCode: "E151002",
			});
		},
	);
	const env = {
		DESCOPE_PROJECT_ID: "project",
		DESCOPE_MANAGEMENT_KEY: "test-key",
	};
	const selection = {
		appId: "provider",
		externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
	};
	it.each([
		{ owner: "user", scopes: undefined, kind: "named_user_latest" },
		{ owner: "user", scopes: ["read"], kind: "named_user_scoped" },
		{ owner: "tenant", scopes: undefined, kind: "named_tenant_latest" },
		{ owner: "tenant", scopes: ["read"], kind: "named_tenant_scoped" },
	])(
		"retains bounded named-path provenance ($kind)",
		async ({ owner, scopes, kind }) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				jsonResponse(
					{
						errorCode: "E151002",
						errorDescription: "private-secret",
						accessToken: "private-secret",
					},
					401,
				),
			);
			const request =
				owner === "user"
					? fetchPersonalConnectionToken(env, {
							...selection,
							userId: "owner",
							scopes,
						})
					: fetchNamedTenantConnectionToken(env, {
							...selection,
							tenantId: "owner",
							scopes,
						});
			const error = await request.catch((e) => e);
			expect(error).toMatchObject({
				status: 401,
				lookupKind: kind,
				upstreamCode: "E151002",
			});
			expect(error.message).not.toContain("private-secret");
		},
	);
	it("retains named latest provenance after scoped absence", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({}, 404))
			.mockResolvedValueOnce(jsonResponse({ errorCode: "E151002" }, 401));
		const error = await fetchNamedTenantConnectionToken(env, {
			...selection,
			tenantId: "owner",
			scopes: ["read"],
		}).catch((e) => e);
		expect(error).toMatchObject({
			status: 401,
			lookupKind: "named_tenant_latest",
			upstreamCode: "E151002",
		});
	});
	it("redacts named transport failures while retaining the attempted lookup", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("private-secret"));
		const error = await fetchNamedTenantConnectionToken(env, {
			...selection,
			tenantId: "owner",
			scopes: ["read"],
		}).catch((e) => e);
		expect(error).toMatchObject({ lookupKind: "named_tenant_scoped" });
		expect(error.message).not.toContain("private-secret");
		expect(error.cause).toBeUndefined();
	});
	it.each([
		"not json",
		JSON.stringify({
			errorCode: "E151002",
			errorDescription: "private-secret".repeat(500),
		}),
		JSON.stringify({ errorCode: "private-secret" }),
	])(
		"omits malformed, oversized or untrusted named diagnostics",
		async (body) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(body, { status: 401 }),
			);
			const error = await fetchPersonalConnectionToken(env, {
				...selection,
				userId: "owner",
			}).catch((e) => e);
			expect(error).toMatchObject({
				status: 401,
				lookupKind: "named_user_latest",
			});
			expect(error.upstreamCode).toBeUndefined();
			expect(error.message).not.toContain("private-secret");
		},
	);
});
