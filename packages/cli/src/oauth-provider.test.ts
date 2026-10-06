import * as credentialLocks from "./credential-lock";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { auth } from "@modelcontextprotocol/client";
import { TedixHomeClient } from "./home-client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readWorkspaceCredentials,
	removeWorkspace,
	writeWorkspaceCredentials,
} from "./credential-store";
import {
	beginSdkOAuthLogin,
	canPromptForConsent,
	isTedixHostedMcpUrl,
	minimalScopeProfileFor,
	OAuthConsentRequiredError,
	prepareTedixCliAuthorization,
	TEDIX_OAUTH_CLIENT_ID,
	TEDIX_OAUTH_CLIENT_URI,
	TEDIX_OAUTH_LOGO_URI,
	selectInteractiveOAuthChallengeScope,
	selectInteractiveOAuthScope,
	selectRequestedOAuthScope,
	issuedOAuthScopes,
	WorkspaceOAuthProvider,
	TEDIX_CONNECT_MCP_URL,
	sessionNeedsRefresh,
	refreshStoredSession,
	SESSION_REFRESH_SKEW_SECONDS,
	SESSION_REFRESH_TIMEOUT_MS,
} from "./oauth-provider";
import { TEDIX_CLI_OAUTH_REDIRECT_URI } from "@tedix/auth/oauth-client-registration";
import { scopesBeyondGrant, validatedLoginTenant } from "./oauth-tenant";
import {
	HUMAN_CONNECT_CONSENT_SCOPES,
	selectConsentPreset,
} from "@tedix/mcp-shared/auth/consent-scopes";

const jwt = (claims: object) =>
	`header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const MCP_URL = "https://acme-unified.mcp.tedix.dev/mcp";
const RESOURCE_METADATA =
	"https://acme-unified.mcp.tedix.dev/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth.example.com/tenant";

test("multi-organization login accepts only a signed bounded selection", () => {
	const valid = {
		iss: "https://api.descope.com/v1/apps/agentic/Ptest/RStest",
		azp: "client-1",
		token_type: "access_token",
		aud: TEDIX_CONNECT_MCP_URL,
		dci: "consent-1",
		tedixSelectedOrganizations: ["org_tedix", "org_sample"],
	};
	expect(
		validatedLoginTenant({
			isTedixHosted: true,
			multiOrganizationResource: true,
			expectedResource: TEDIX_CONNECT_MCP_URL,
			tokenClaims: valid,
		}),
	).toBeUndefined();
	expect(
		validatedLoginTenant({
			isTedixHosted: true,
			multiOrganizationResource: true,
			expectedResource: TEDIX_CONNECT_MCP_URL,
			tokenClaims: { ...valid, aud: [valid.azp, "Ptest", valid.aud] },
		}),
	).toBeUndefined();
	for (const bad of [
		{ ...valid, aud: [valid.azp, valid.iss] },
		{ ...valid, aud: [valid.aud, "Pother"] },
		{ ...valid, aud: [valid.aud, "https://another.example/mcp"] },
		{ ...valid, aud: [valid.aud, 123] },
		{ ...valid, tedixSelectedOrganizations: [] },
		{ ...valid, tedixSelectedOrganizations: ["org_tedix", "org_tedix"] },
		{ ...valid, dci: undefined },
		{ ...valid, aud: "https://tedix-unified.mcp.tedix.dev/mcp" },
	]) {
		expect(() =>
			validatedLoginTenant({
				isTedixHosted: true,
				multiOrganizationResource: true,
				expectedResource: TEDIX_CONNECT_MCP_URL,
				tokenClaims: bad,
			}),
		).toThrow("no valid selected organizations");
	}
});

function oauthFetch(accessToken = jwt({ sub: "user-1", dct: "org_acme" })) {
	return async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url === RESOURCE_METADATA)
			return Response.json({
				resource: MCP_URL,
				authorization_servers: [ISSUER],
				scopes_supported: ["mcp:apps.read", "mcp:apps.write", "mcp:apps.admin"],
			});
		if (url.includes(".well-known/oauth-authorization-server"))
			return Response.json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		if (url === `${ISSUER}/token`)
			return Response.json({
				access_token: accessToken,
				token_type: "Bearer",
				scope: "mcp:apps.read",
			});
		throw new Error(`Unexpected test request ${url}`);
	};
}

describe("WorkspaceOAuthProvider", () => {
	test.each(["ordinary", "reads", "platform"])(
		"Connect consent choices preserve exact issued reads (request: %s)",
		async (request) => {
			const explicitReads = request === "reads";
			let authorization: URL | undefined;
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: TEDIX_CONNECT_MCP_URL,
				loadStored: false,
				staticClientId: TEDIX_OAUTH_CLIENT_ID,
				offerConsentChoices: true,
				...(request === "platform"
					? { scopeProfile: "platform-admin" as const }
					: {}),
				...(explicitReads ? { requestedScopes: ["mcp:apps.read"] } : {}),
				captureCallback: async (url) => {
					authorization = url;
					return new URLSearchParams({ code: "code" });
				},
			});
			const baseFetch = oauthFetch(
				jwt({
					sub: "user-1",
					iss: "https://api.descope.com/v1/apps/agentic/Ptest/Rtest",
					azp: TEDIX_OAUTH_CLIENT_ID,
					token_type: "access_token",
					aud: TEDIX_CONNECT_MCP_URL,
					dci: "consent-1",
					tedixSelectedOrganizations: ["org_tedix"],
				}),
			);
			await beginSdkOAuthLogin(provider, TEDIX_CONNECT_MCP_URL, {
				fetchFn: async (input) =>
					String(input).includes("oauth-protected-resource")
						? Response.json({
								resource: TEDIX_CONNECT_MCP_URL,
								authorization_servers: [ISSUER],
								scopes_supported: [
									...HUMAN_CONNECT_CONSENT_SCOPES,
									"offline_access",
									"platform:admin",
									"unknown.read",
								],
							})
						: baseFetch(input),
			});
			const requested = authorization!.searchParams.get("scope")!.split(" ");
			expect(requested).toEqual(
				explicitReads
					? ["mcp:apps.read", "offline_access"]
					: [
							...HUMAN_CONNECT_CONSENT_SCOPES,
							...(request === "platform" ? ["platform:admin"] : []),
							"offline_access",
						],
			);
			expect(
				selectConsentPreset(
					requested.map((name) => ({ name })),
					"read",
				).every(
					(scope) =>
						!scope.endsWith(".write") &&
						!scope.endsWith(".admin") &&
						scope !== "connections.execute",
				),
			).toBe(true);
			expect(issuedOAuthScopes(provider.credential())).toEqual([
				"mcp:apps.read",
			]);
		},
	);
	test.each(["success", "wrong-tenant", "save-failed"] as const)(
		"completes real browser callback after validated durable save: %s",
		async (result) => {
			let browserResponse: Promise<Response> | undefined;
			let saved = false;
			const configDir = mkdtempSync(join(tmpdir(), "tedix-browser-save-"));
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				tenant: "org_acme",
				staticClientId: TEDIX_OAUTH_CLIENT_ID,
				scopeProfile: "member",
				timeoutMs: 2_000,
				openAuthorization: (authorization) => {
					const state = new URL(authorization).searchParams.get("state")!;
					const port = state.split(".").at(-1);
					browserResponse = fetch(
						`http://localhost:${port}/callback?code=code&state=${encodeURIComponent(state)}`,
					);
				},
			});
			const login = beginSdkOAuthLogin(provider, MCP_URL, {
				fetchFn: oauthFetch(
					jwt({
						sub: "user-1",
						dct: result === "wrong-tenant" ? "org_other" : "org_acme",
					}),
				),
				commit: async (credential) => {
					expect(credential.org).toBe("org_acme");
					expect(credential.oauthScopeProfile).toBe("member");
					if (result === "save-failed") throw new Error("disk unavailable");
					writeWorkspaceCredentials("browser", credential, { configDir });
					saved = true;
				},
			});
			if (result === "success") await login;
			else await expect(login).rejects.toThrow();
			const response = await browserResponse!;
			expect(response.status).toBe(result === "success" ? 200 : 400);
			expect(saved).toBe(result === "success");
			expect(readWorkspaceCredentials("browser", { configDir }) !== null).toBe(
				result === "success",
			);
			if (result !== "success") expect(provider.tokens()).toBeUndefined();
		},
	);

	test("automatic authorization validates tenant before replacing stored credentials", async () => {
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = mkdtempSync(
			join(tmpdir(), "tedix-tenant-write-"),
		);
		try {
			const initial = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				tenant: "org_acme",
				staticClientId: TEDIX_OAUTH_CLIENT_ID,
				captureCallback: async () => new URLSearchParams({ code: "code" }),
			});
			await beginSdkOAuthLogin(initial, MCP_URL, {
				fetchFn: oauthFetch(),
				commit: (credential) => writeWorkspaceCredentials("tenant", credential),
			});
			const before = readWorkspaceCredentials("tenant");
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				workspace: "tenant",
				persist: true,
				captureCallback: async () => new URLSearchParams({ code: "code" }),
			});
			await expect(
				provider.authorizeInteractive({
					serverUrl: MCP_URL,
					forceReauthorization: true,
					fetchFn: oauthFetch(jwt({ sub: "user-1", dct: "org_other" })),
				}),
			).rejects.toThrow("requested org_acme");
			expect(readWorkspaceCredentials("tenant")).toEqual(before);
			expect(provider.tokens()?.access_token).toBe(
				before?.oauthTokens?.access_token,
			);
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});

	test("reloaded member profile rejects an admin challenge before opening consent", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-profile-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		try {
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				tenant: "org_acme",
				scopeProfile: "member",
				staticClientId: TEDIX_OAUTH_CLIENT_ID,
				captureCallback: async () => new URLSearchParams({ code: "code" }),
			});
			await beginSdkOAuthLogin(provider, MCP_URL, {
				fetchFn: oauthFetch(),
				commit: (credential) => writeWorkspaceCredentials("member", credential),
			});
			let opened = false;
			const reloaded = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				workspace: "member",
				captureCallback: async () => {
					opened = true;
					return new URLSearchParams();
				},
			});
			expect(reloaded.scopeProfile).toBe("member");
			for (const challengedScope of [
				"mcp:apps.admin",
				"connections.admin",
				"tedi:admin",
				"unknown.execute",
			]) {
				await expect(
					reloaded.authorizeScopeChallenge(challengedScope),
				).rejects.toThrow("no scopes usable");
			}
			expect(opened).toBe(false);
			expect(readWorkspaceCredentials("member")?.oauthScopeProfile).toBe(
				"member",
			);
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});

	test("binds the stable HTTPS broker redirect to one ephemeral loopback port", () => {
		const prepared = prepareTedixCliAuthorization({
			authorizationUrl: new URL(
				`${ISSUER}/authorize?state=nonce&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcallback`,
			),
			expectedState: "nonce",
			loopbackPort: 49_152,
		});
		expect(prepared.expectedState).toBe("nonce.49152");
		expect(prepared.authorizationUrl.searchParams.get("state")).toBe(
			"nonce.49152",
		);
		expect(prepared.authorizationUrl.searchParams.get("redirect_uri")).toBe(
			TEDIX_CLI_OAUTH_REDIRECT_URI,
		);
	});

	test("recognizes Tedix-hosted MCP gateways", () => {
		expect(isTedixHostedMcpUrl(MCP_URL)).toBe(true);
		expect(isTedixHostedMcpUrl("https://mcp.tedix.dev/mcp")).toBe(true);
		expect(isTedixHostedMcpUrl("https://mcp.example.com/mcp")).toBe(false);
		expect(isTedixHostedMcpUrl("not a URL")).toBe(false);
	});

	test("publishes first-party branding in client registration metadata", () => {
		const provider = new WorkspaceOAuthProvider({ mcpUrl: MCP_URL });
		expect(provider.clientMetadata.client_uri).toBe(TEDIX_OAUTH_CLIENT_URI);
		expect(provider.clientMetadata.logo_uri).toBe(TEDIX_OAUTH_LOGO_URI);
	});

	test("keeps OAuth state stable for one transaction and rotates after callback", async () => {
		const observedStates: string[] = [];
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			captureCallback: async (_url, state) => {
				observedStates.push(state);
				return new URLSearchParams({ code: "authorization-code", state });
			},
		});

		const first = provider.state();
		expect(provider.state()).toBe(first);
		await provider.redirectToAuthorization(
			new URL(`${ISSUER}/authorize?state=${first}`),
		);
		await provider.waitForCallback();

		expect(observedStates).toEqual([first]);
		expect(provider.state()).not.toBe(first);
	});

	test("reuses one loopback capture when the SDK repeats the redirect", async () => {
		let captures = 0;
		let resolveCallback: ((value: URLSearchParams) => void) | undefined;
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			captureCallback: (_url, state) => {
				captures += 1;
				return new Promise<URLSearchParams>((resolve) => {
					resolveCallback = (value) => {
						value.set("state", state);
						resolve(value);
					};
				});
			},
		});
		const state = provider.state();
		const authorizationUrl = new URL(`${ISSUER}/authorize?state=${state}`);

		await provider.redirectToAuthorization(authorizationUrl);
		await provider.redirectToAuthorization(new URL(authorizationUrl));
		expect(captures).toBe(1);

		resolveCallback?.(new URLSearchParams({ code: "authorization-code" }));
		await expect(provider.waitForCallback()).resolves.toEqual(
			new URLSearchParams({ code: "authorization-code", state }),
		);
	});

	test("always opens the organization chooser for a Connect login", async () => {
		let captured: URL | undefined;
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: TEDIX_CONNECT_MCP_URL,
			captureCallback: async (url) => {
				captured = url;
				return new URLSearchParams();
			},
		});
		await provider.redirectToAuthorization(
			new URL(`${ISSUER}/authorize?state=${provider.state()}`),
		);
		expect(captured?.searchParams.get("prompt")).toBe("consent");
		expect(captured?.searchParams.has("tenant")).toBe(false);
	});

	test("defaults to known reads and rejects write escalation", () => {
		expect(
			selectInteractiveOAuthScope([
				"mcp:apps.read",
				"mcp:apps.write",
				"connections.read",
				"connections.execute",
				"connections.admin",
				"unknown.read",
				"offline_access",
			]),
		).toBe("mcp:apps.read connections.read offline_access");
		expect(() =>
			selectInteractiveOAuthChallengeScope(
				"mcp:apps.read",
				"connections.execute",
			),
		).toThrow("no scopes usable");
		const provider = new WorkspaceOAuthProvider({
			workspace: "read-profile",
			mcpUrl: MCP_URL,
			loadStored: false,
			credential: { loginId: "reader", oauthScopeProfile: "read" },
		});
		expect(provider.scopeProfile).toBe("read");
		provider.reloadCredential({
			loginId: "reader",
			oauthScopeProfile: "admin",
		});
		expect(provider.scopeProfile).toBe("admin");
	});

	test("selects least-privilege interactive scope profiles", () => {
		const supported = [
			"profile",
			"mcp:apps",
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:apps.admin",
			"mcp:settings",
			"platform:admin",
			"mcp:search.listings",
		];
		expect(selectInteractiveOAuthScope(supported, "member")).toBe(
			"profile mcp:apps.read mcp:apps.write",
		);
		expect(selectInteractiveOAuthScope(supported, "admin")).toBe(
			"profile mcp:apps.read mcp:apps.write mcp:apps.admin",
		);
		expect(selectInteractiveOAuthScope(supported, "platform-admin")).toBe(
			"profile mcp:apps mcp:apps.read mcp:apps.write mcp:apps.admin mcp:settings platform:admin mcp:search.listings",
		);
	});

	test("constrains insufficient_scope challenges to the interactive profile", () => {
		expect(() =>
			selectInteractiveOAuthChallengeScope(
				"mcp:apps.read mcp:apps.write",
				"platform:admin",
			),
		).toThrow("no scopes usable");
		expect(
			selectInteractiveOAuthChallengeScope(
				"mcp:apps.read",
				"mcp:apps.write",
				"member",
			),
		).toBe("mcp:apps.read mcp:apps.write");
	});

	test("member and admin classify only known capability and protocol scopes", () => {
		const supported = [
			"openid",
			"offline_access",
			"profile",
			"email",
			"connections.read",
			"connections.execute",
			"connections.admin",
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:apps.admin",
			"tedi:brain.read",
			"tedi:brain.write",
			"tedi:admin",
			"unknown.read",
			"unknown.write",
			"unknown.admin",
			"mcp:unknown.write",
			"tedi:unknown.write",
			"platform:admin",
		];
		expect(selectInteractiveOAuthScope(supported, "member").split(" ")).toEqual(
			[
				"openid",
				"offline_access",
				"profile",
				"email",
				"connections.read",
				"connections.execute",
				"mcp:apps.read",
				"mcp:apps.write",
				"tedi:brain.read",
				"tedi:brain.write",
			],
		);
		expect(selectInteractiveOAuthScope(supported, "admin").split(" ")).toEqual(
			supported.slice(0, 13),
		);
		// Full advertised authority remains an explicit opt-in escape hatch for
		// non-Tedix resources whose scope vocabulary the CLI does not classify.
		expect(
			selectInteractiveOAuthScope(supported, "platform-admin").split(" "),
		).toEqual(supported);
		for (const profile of ["member", "admin"] as const) {
			expect(() =>
				selectInteractiveOAuthScope(
					["mcp:unknown.write", "unknown.admin"],
					profile,
				),
			).toThrow("no scopes usable");
		}
	});

	test("requests only selected supported capability scopes before consent", () => {
		expect(
			selectRequestedOAuthScope(
				[
					"offline_access",
					"openid",
					"profile",
					"mcp:apps.read",
					"mcp:apps.admin",
					"platform:admin",
				],
				["mcp:apps.read"],
			),
		).toBe("mcp:apps.read openid offline_access profile");
		expect(() =>
			selectRequestedOAuthScope(["mcp:apps.read"], ["mcp:apps.admin"]),
		).toThrow("not supported");
		expect(() =>
			selectRequestedOAuthScope(["platform:admin"], ["platform:root"]),
		).toThrow("not supported");
	});

	test("requests the exact tenant profile and persists only issued scopes", async () => {
		let authorizationUrl: URL | undefined;
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			staticClientId: TEDIX_OAUTH_CLIENT_ID,
			captureCallback: async (url, state) => {
				authorizationUrl = new URL(url);
				return new URLSearchParams({ code: "authorization-code", state });
			},
		});
		const fetchFn = async (
			input: string | URL | Request,
		): Promise<Response> => {
			const url = String(input);
			if (url === RESOURCE_METADATA) {
				return Response.json({
					resource: MCP_URL,
					authorization_servers: [ISSUER],
					scopes_supported: [
						"mcp:apps",
						"mcp:apps.read",
						"mcp:apps.write",
						"mcp:apps.admin",
						"mcp:settings",
						"platform:admin",
					],
				});
			}
			if (url.includes(".well-known/oauth-authorization-server")) {
				return Response.json({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/authorize`,
					token_endpoint: `${ISSUER}/token`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			}
			if (url === `${ISSUER}/token`) {
				return Response.json({
					access_token: jwt({ sub: "user-1", dct: "org_acme" }),
					token_type: "Bearer",
					scope: "mcp:apps.read mcp:apps.write",
				});
			}
			throw new Error(`Unexpected OAuth fetch: ${url}`);
		};

		await beginSdkOAuthLogin(provider, MCP_URL, { fetchFn });

		expect(authorizationUrl?.searchParams.get("scope")).toBe("mcp:apps.read");
		expect(authorizationUrl?.searchParams.get("prompt")).toBeNull();
		expect(issuedOAuthScopes(provider.credential())).toEqual([
			"mcp:apps.read",
			"mcp:apps.write",
		]);
	});

	test("empty canonical state does not reconstruct retired token fields", () => {
		const stale = {
			loginId: "user-1",
			sessionJwt: "retired-access-token",
			refreshJwt: "retired-refresh-token",
			clientId: "retired-client",
			scopes: "mcp:tools",
		};
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: stale,
			loadStored: false,
		});
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()).toBeUndefined();
	});

	test.each([false, true])(
		"binds 401 recovery to one PKCE transaction (concurrent: %s)",
		async (concurrent) => {
			let authorizationUrl: URL | undefined;
			const methods: string[] = [];
			const tokenRequests: URLSearchParams[] = [];
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				staticClientId: TEDIX_OAUTH_CLIENT_ID,
				tenant: "org_acme",
				captureCallback: async (url, state) => {
					authorizationUrl = new URL(url);
					await new Promise((resolve) => setTimeout(resolve, 30));
					return new URLSearchParams({ code: "authorization-code", state });
				},
			});
			const fetch = async (
				input: string | URL | Request,
				init?: RequestInit,
			): Promise<Response> => {
				const url = String(input);
				if (url === RESOURCE_METADATA) {
					return Response.json({
						resource: MCP_URL,
						authorization_servers: [ISSUER],
						scopes_supported: ["mcp:apps.read"],
					});
				}
				if (url.includes(".well-known/oauth-authorization-server")) {
					return Response.json({
						issuer: ISSUER,
						authorization_endpoint: `${ISSUER}/authorize`,
						token_endpoint: `${ISSUER}/token`,
						response_types_supported: ["code"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: ["none"],
					});
				}
				if (url === `${ISSUER}/token`) {
					tokenRequests.push(new URLSearchParams(String(init?.body)));
					const verifier = tokenRequests.at(-1)?.get("code_verifier") ?? "";
					const challenge = Buffer.from(
						await crypto.subtle.digest(
							"SHA-256",
							new TextEncoder().encode(verifier),
						),
					).toString("base64url");
					if (
						challenge !== authorizationUrl?.searchParams.get("code_challenge")
					) {
						return Response.json(
							{
								errorCode: "E066002",
								errorMessage: "Invalid PKCE code challenge",
							},
							{ status: 401 },
						);
					}
					return Response.json({
						access_token: jwt({ sub: "user-1", dct: "org_acme" }),
						refresh_token: "new-refresh-token",
						token_type: "Bearer",
						expires_in: 3600,
						scope: "mcp:tools",
					});
				}
				if (url === MCP_URL) {
					const body = JSON.parse(String(init?.body)) as {
						id: string;
						method: string;
					};
					methods.push(body.method);
					const authorization = new Headers(init?.headers).get("Authorization");
					if (
						authorization !==
						`Bearer ${jwt({ sub: "user-1", dct: "org_acme" })}`
					) {
						return new Response("Unauthorized", {
							status: 401,
							headers: {
								"WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}"`,
							},
						});
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result:
							body.method === "server/discover"
								? { supportedVersions: ["2026-07-28"] }
								: { structuredContent: { ok: true } },
					});
				}
				throw new Error(`Unexpected OAuth fetch: ${url}`);
			};

			const client = new TedixHomeClient({
				fetch,
				headers: {},
				oauthProvider: provider,
				url: MCP_URL,
			});
			await expect(client.runCode("async () => true")).resolves.toEqual({
				ok: true,
			});
			if (concurrent) {
				await provider.invalidateCredentials("tokens");
				await expect(
					Promise.all([
						client.runCode("async () => true"),
						client.runCode("async () => true"),
					]),
				).resolves.toEqual([{ ok: true }, { ok: true }]);
			}

			await client.close();

			expect(authorizationUrl?.searchParams.get("tenant")).toBe("org_acme");
			expect(authorizationUrl?.searchParams.get("prompt")).toBe("consent");
			expect(authorizationUrl?.searchParams.get("state")).toBeTruthy();
			expect(authorizationUrl?.searchParams.get("code_challenge")).toBeTruthy();
			expect(authorizationUrl?.searchParams.get("resource")).toBe(MCP_URL);
			expect(tokenRequests).toHaveLength(concurrent ? 2 : 1);
			expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
			expect(tokenRequests[0]?.get("client_id")).toBe(TEDIX_OAUTH_CLIENT_ID);
			expect(tokenRequests[0]?.has("tenantId")).toBe(false);
			expect(tokenRequests[0]?.get("resource")).toBe(MCP_URL);
			expect(provider.tokens()?.access_token).toBe(
				jwt({ sub: "user-1", dct: "org_acme" }),
			);
			expect(provider.credential().oauthResourceUrl).toBe(MCP_URL);
		},
	);

	test.each(["refreshed", "not-needed", "invalidated"] as const)(
		"transport 401 uses guarded renewal (%s) without opening consent",
		async (outcome) => {
			let refreshes = 0;
			let captures = 0;
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				captureCallback: async () => {
					captures++;
					throw new Error("unexpected consent");
				},
			});
			await provider.saveTokens({
				access_token: "old",
				refresh_token: "rotating",
				token_type: "Bearer",
			});
			provider.refreshSession = async () => {
				refreshes++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (outcome !== "invalidated")
					await provider.saveTokens({
						access_token: "new",
						token_type: "Bearer",
					});
				return outcome;
			};
			let rejectToken = false;
			const client = new TedixHomeClient({
				url: MCP_URL,
				headers: {},
				oauthProvider: provider,
				fetch: async (_input, init) => {
					const request = JSON.parse(String(init?.body));
					if (
						rejectToken &&
						new Headers(init?.headers).get("Authorization") !== "Bearer new"
					) {
						return new Response("Unauthorized", { status: 401 });
					}
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result:
							request.method === "server/discover"
								? { supportedVersions: ["2026-07-28"] }
								: { structuredContent: { ok: true } },
					});
				},
			});
			await client.runCode("async () => true");
			rejectToken = true;
			const results = await Promise.allSettled([
				client.runCode("async () => true"),
				client.runCode("async () => true"),
			]);
			expect(results.map((result) => result.status)).toEqual(
				outcome === "invalidated"
					? ["rejected", "rejected"]
					: ["fulfilled", "fulfilled"],
			);
			expect(refreshes).toBe(1);
			expect(captures).toBe(0);
			await client.close();
		},
	);

	test("restores the persisted resource and sends it when refreshing", async () => {
		let tokenRequest: URLSearchParams | undefined;
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",

				accessTokenExpiresAtSeconds: 0,
				mcpUrl: MCP_URL,
				oauthResourceUrl: MCP_URL,
				oauthTokens: {
					access_token: "old-access-token",
					refresh_token: "refresh-token",
					token_type: "Bearer",
					issuer: ISSUER,
				},
				oauthClientInformation: {
					client_id: "client-1",
					issuer: ISSUER,
				},
				oauthDiscoveryState: {
					authorizationServerUrl: ISSUER,
					resourceMetadata: {
						resource: MCP_URL,
						authorization_servers: [ISSUER],
					},
					authorizationServerMetadata: {
						issuer: ISSUER,
						authorization_endpoint: `${ISSUER}/authorize`,
						token_endpoint: `${ISSUER}/token`,
						response_types_supported: ["code"],
					},
				},
			},
		});

		expect(provider.resourceUrl()).toBe(MCP_URL);
		await expect(
			auth(provider, {
				serverUrl: MCP_URL,
				fetchFn: async (_input, init) => {
					tokenRequest = new URLSearchParams(String(init?.body));
					return Response.json({
						access_token: "refreshed-access-token",
						refresh_token: "refreshed-refresh-token",
						token_type: "Bearer",
					});
				},
			}),
		).resolves.toBe("AUTHORIZED");

		expect(tokenRequest?.get("grant_type")).toBe("refresh_token");
		expect(tokenRequest?.get("resource")).toBe(MCP_URL);
		expect(provider.credential().oauthResourceUrl).toBe(MCP_URL);
	});
});

test("issued scopes never infer a grant from roles or missing claims", () => {
	const jwt = (claims: object) =>
		`header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	expect(
		issuedOAuthScopes({
			oauthTokens: {
				token_type: "Bearer",
				access_token: jwt({ roles: ["owner"] }),
			},
		}),
	).toBeNull();
	expect(
		issuedOAuthScopes({
			oauthTokens: {
				token_type: "Bearer",
				access_token: jwt({ scope: "mcp:apps.read" }),
				scope: "platform:admin",
			},
		}),
	).toEqual(["mcp:apps.read"]);
	expect(
		issuedOAuthScopes({
			oauthTokens: { token_type: "Bearer", access_token: jwt({ scope: [] }) },
		}),
	).toEqual([]);
});

describe("proactive session refresh", () => {
	const NOW = 1_800_000_000;

	test("treats a token inside the skew as stale, not fresh", () => {
		// The exact bug: a token with seconds left passed every check the CLI made
		// (there were none) and then expired mid-request. Anything at or inside the
		// skew must renew.
		expect(
			sessionNeedsRefresh(
				{
					oauthTokens: {
						token_type: "Bearer",
						access_token: "access",
						refresh_token: "r",
					},
					accessTokenExpiresAtSeconds: NOW + SESSION_REFRESH_SKEW_SECONDS - 1,
				},
				NOW,
			),
		).toBe(true);
		expect(
			sessionNeedsRefresh(
				{
					oauthTokens: {
						token_type: "Bearer",
						access_token: "access",
						refresh_token: "r",
					},
					accessTokenExpiresAtSeconds: NOW - 1,
				},
				NOW,
			),
		).toBe(true);
		expect(
			sessionNeedsRefresh(
				{
					oauthTokens: {
						token_type: "Bearer",
						access_token: "access",
						refresh_token: "r",
					},
					accessTokenExpiresAtSeconds: NOW + SESSION_REFRESH_SKEW_SECONDS + 60,
				},
				NOW,
			),
		).toBe(false);
	});

	test("an unknown expiry renews rather than gambles", () => {
		expect(
			sessionNeedsRefresh(
				{
					oauthTokens: {
						token_type: "Bearer",
						access_token: "access",
						refresh_token: "r",
					},
					accessTokenExpiresAtSeconds: 0,
				},
				NOW,
			),
		).toBe(true);
	});

	test("without a refresh token there is nothing to renew", () => {
		expect(
			sessionNeedsRefresh(
				{
					oauthTokens: {
						token_type: "Bearer",
						access_token: "access",
						refresh_token: "",
					},
					accessTokenExpiresAtSeconds: 0,
				},
				NOW,
			),
		).toBe(false);
	});

	test("renews from the refresh token and persists the new access token", async () => {
		let refreshRequestScope = "";
		const freshToken = jwt({
			dct: "org_acme",
			scope: "mcp:apps.read mcp:apps.write",
		});
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",
				org: "org_acme",
				accessTokenExpiresAtSeconds: NOW - 1,

				oauthTokens: {
					access_token: "stale-access-token",
					refresh_token: "refresh-token",
					scope: "mcp:apps.read mcp:apps.write",
					token_type: "Bearer",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			},
		});

		const fetchFn = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/.well-known/")) {
				return new Response(
					JSON.stringify({
						issuer: "https://auth.example.test",
						token_endpoint: "https://auth.example.test/token",
						response_types_supported: ["code"],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			refreshRequestScope =
				new URLSearchParams(init?.body as URLSearchParams).get("scope") ?? "";
			return new Response(
				JSON.stringify({
					access_token: freshToken,
					scope: "mcp:apps.read mcp:apps.write",
					token_type: "Bearer",
					expires_in: 600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as NonNullable<
			Parameters<typeof refreshStoredSession>[1]
		>["fetchFn"];

		const outcome = await refreshStoredSession(provider, { fetchFn });

		expect(outcome).toBe("refreshed");
		expect(refreshRequestScope).toBe("mcp:apps.read mcp:apps.write");
		expect(provider.tokens()?.access_token).toBe(freshToken);
		expect(provider.tokens()?.scope).toBe("mcp:apps.read mcp:apps.write");
		// A server that does not rotate the refresh token must not strand the next
		// renewal.
		expect(provider.tokens()?.refresh_token).toBe("refresh-token");
	});

	test("rejects a refresh response that widens the saved grant", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",

				accessTokenExpiresAtSeconds: NOW - 1,

				oauthTokens: {
					access_token: "stale-access-token",
					refresh_token: "refresh-token",
					scope: "mcp:apps.read",
					token_type: "Bearer",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			},
		});
		const fetchFn = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/.well-known/")) {
				return new Response(
					JSON.stringify({
						issuer: "https://auth.example.test",
						token_endpoint: "https://auth.example.test/token",
						response_types_supported: ["code"],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					access_token: "over-scoped-access-token",
					refresh_token: "rotated-refresh-token",
					scope: "mcp:apps.read platform:admin",
					token_type: "Bearer",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as NonNullable<
			Parameters<typeof refreshStoredSession>[1]
		>["fetchFn"];

		expect(await refreshStoredSession(provider, { fetchFn })).toBe(
			"scope-expanded",
		);
		expect(provider.tokens()?.access_token).toBe("stale-access-token");
		expect(provider.tokens()?.refresh_token).toBe("refresh-token");
	});

	test.each([
		{
			name: "reordered",
			before: ["org_tedix", "org_sample"],
			after: ["org_sample", "org_tedix"],
			expected: "refreshed" as const,
		},
		{
			name: "maximum bounded selection",
			before: Array.from({ length: 10 }, (_, i) =>
				i === 0 ? "x".repeat(256) : `org_${i}`,
			),
			after: Array.from({ length: 10 }, (_, i) =>
				i === 9 ? "x".repeat(256) : `org_${9 - i}`,
			),
			expected: "refreshed" as const,
		},
		{
			name: "added",
			before: ["org_tedix"],
			after: ["org_tedix", "org_sample"],
			expected: "failed" as const,
		},
		{
			name: "removed",
			before: ["org_tedix", "org_sample"],
			after: ["org_tedix"],
			expected: "failed" as const,
		},
		{
			name: "replaced",
			before: ["org_tedix"],
			after: ["org_sample"],
			expected: "failed" as const,
		},
		...[
			undefined,
			null,
			"org_tedix",
			[],
			[123],
			[""],
			["x".repeat(257)],
			["org_tedix", "org_tedix"],
			Array.from({ length: 11 }, (_, i) => `org_${i}`),
		].flatMap((invalid, index) => [
			{
				name: `malformed previous ${index}`,
				before: invalid,
				after: ["org_tedix"],
				expected: "failed" as const,
			},
			{
				name: `malformed renewed ${index}`,
				before: ["org_tedix"],
				after: invalid,
				expected: "failed" as const,
			},
			{
				name: `identical malformed ${index}`,
				before: invalid,
				after: invalid,
				expected: "failed" as const,
			},
		]),
	])(
		"validates selected organization membership on renewal: $name",
		async ({ before, after, expected }) => {
			const oldToken = jwt({ tedixSelectedOrganizations: before });
			const renewedToken = jwt({
				aud: TEDIX_CONNECT_MCP_URL,
				token_type: "access_token",
				dci: "client-1",
				tedixSelectedOrganizations: after,
			});
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: TEDIX_CONNECT_MCP_URL,
				credential: {
					loginId: "user-1",
					mcpUrl: TEDIX_CONNECT_MCP_URL,
					accessTokenExpiresAtSeconds: NOW - 1,
					oauthTokens: {
						access_token: oldToken,
						refresh_token: "refresh-token",
						scope: "mcp:apps.read",
						token_type: "Bearer",
					},
					oauthClientInformation: { client_id: "client-1" },
					oauthDiscoveryState: {
						authorizationServerUrl: "https://auth.example.test",
					},
				},
			});
			provider.saveResourceUrl(TEDIX_CONNECT_MCP_URL);
			const fetchFn = (async (input: string | URL | Request) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes("/.well-known/")) {
					return Response.json({
						issuer: "https://auth.example.test",
						token_endpoint: "https://auth.example.test/token",
						response_types_supported: ["code"],
					});
				}
				return Response.json({
					access_token: renewedToken,
					refresh_token: "rotated",
					scope: "mcp:apps.read",
					token_type: "Bearer",
				});
			}) as unknown as NonNullable<
				Parameters<typeof refreshStoredSession>[1]
			>["fetchFn"];
			expect(await refreshStoredSession(provider, { fetchFn })).toBe(expected);
			expect(provider.tokens()?.access_token).toBe(
				expected === "refreshed" ? renewedToken : oldToken,
			);
			expect(provider.tokens()?.refresh_token).toBe(
				expected === "refreshed" ? "rotated" : "refresh-token",
			);
		},
	);

	// The double-check that makes the lock worth having: after waiting for a
	// sibling's renewal, the credential on disk is already fresh, so renewing
	// again would present the token the sibling just superseded — precisely the
	// replay that invalidates the whole family.
	test("adopts a sibling's renewal instead of presenting the token it superseded", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-oauth-sibling-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		try {
			const fresh = {
				loginId: "user-1",

				// Comfortably outside the skew: a sibling already renewed.

				accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
				oauthTokens: {
					access_token: "sibling-fresh-access",
					token_type: "Bearer",
					refresh_token: "sibling-rotated-refresh",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			};
			writeWorkspaceCredentials("tedix", fresh);

			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				credential: {
					...fresh,
					// This process still holds the SUPERSEDED token in memory.
					accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) - 1,
					oauthTokens: {
						access_token: "stale-access",
						token_type: "Bearer",
						refresh_token: "superseded-refresh",
					},
				},
			});

			let called = false;
			const fetchFn = (async () => {
				called = true;
				return new Response("{}", { status: 200 });
			}) as unknown as NonNullable<
				Parameters<typeof refreshStoredSession>[1]
			>["fetchFn"];

			expect(
				await refreshStoredSession(provider, { fetchFn, workspace: "tedix" }),
			).toBe("not-needed");
			// The decisive assertion: no token request was made at all.
			expect(called).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});

	test("long-lived provider adopts a sibling renewal through its own refresh method", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-oauth-sibling-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		try {
			const fresh = {
				loginId: "user-1",

				// Comfortably outside the skew: a sibling already renewed.

				accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
				oauthTokens: {
					access_token: "sibling-fresh-access",
					token_type: "Bearer",
					refresh_token: "sibling-rotated-refresh",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			};
			writeWorkspaceCredentials("tedix", fresh);

			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				workspace: "tedix",
				credential: {
					...fresh,
					// This process still holds the SUPERSEDED token in memory.
					accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) - 1,
					oauthTokens: {
						access_token: "stale-access",
						token_type: "Bearer",
						refresh_token: "superseded-refresh",
					},
				},
			});

			expect(await provider.refreshSession()).toBe("not-needed");
			expect(provider.tokens()?.access_token).toBe("sibling-fresh-access");
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});

	test("lock timeout fails closed and diagnostics never include raw provider errors", async () => {
		const previous = process.env.TEDIX_DEBUG;
		process.env.TEDIX_DEBUG = "1";
		const lock = spyOn(
			credentialLocks,
			"acquireCredentialLock",
		).mockResolvedValue(null);
		const log = spyOn(console, "error").mockImplementation(() => {});
		let fetched = false;
		try {
			const result = await refreshStoredSession(
				new WorkspaceOAuthProvider({ mcpUrl: MCP_URL }),
				{
					workspace: "busy",
					fetchFn: async () => {
						fetched = true;
						throw new Error("secret-token");
					},
				},
			);
			expect(result).toBe("failed");
			expect(fetched).toBe(false);
			const diagnostic = JSON.parse(String(log.mock.calls[0]?.[1]));
			expect(diagnostic).toMatchObject({
				pid: process.pid,
				workspace: "busy",
				result: "failed",
			});
			expect(typeof diagnostic.lockWaitMs).toBe("number");
			expect(typeof diagnostic.version).toBe("string");
			expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token");
		} finally {
			lock.mockRestore();
			log.mockRestore();
			if (previous === undefined) delete process.env.TEDIX_DEBUG;
			else process.env.TEDIX_DEBUG = previous;
		}
	});

	test.each(["before-refresh", "during-refresh"] as const)(
		"logout wins over a long-lived provider: %s",
		async (timing) => {
			const previous = process.env.TEDIX_CONFIG_DIR;
			process.env.TEDIX_CONFIG_DIR = mkdtempSync(
				join(tmpdir(), "tedix-logout-race-"),
			);
			try {
				const provider = new WorkspaceOAuthProvider({
					mcpUrl: MCP_URL,
					workspace: "race",
					persist: true,
					credential: {
						loginId: "user",
						accessTokenExpiresAtSeconds: 1,

						oauthTokens: {
							access_token: "expired",
							refresh_token: "secret-refresh",
							token_type: "Bearer",
						},
						oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
						oauthDiscoveryState: {
							authorizationServerUrl: ISSUER,
							authorizationServerMetadata: {
								issuer: ISSUER,
								authorization_endpoint: `${ISSUER}/authorize`,
								token_endpoint: `${ISSUER}/token`,
								response_types_supported: ["code"],
							},
						},
					},
				});
				writeWorkspaceCredentials("race", provider.credential());
				if (timing === "before-refresh") removeWorkspace("race");
				let requests = 0;
				const outcome = await refreshStoredSession(provider, {
					workspace: "race",
					fetchFn: async () => {
						requests += 1;
						removeWorkspace("race");
						return Response.json({
							access_token: "new",
							refresh_token: "new-refresh",
							token_type: "Bearer",
						});
					},
				});
				expect(outcome).toBe(
					timing === "before-refresh" ? "unavailable" : "failed",
				);
				expect(requests).toBe(timing === "before-refresh" ? 0 : 1);
				expect(readWorkspaceCredentials("race")).toBeNull();
			} finally {
				if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
				else process.env.TEDIX_CONFIG_DIR = previous;
			}
		},
	);

	test("reports unavailable instead of throwing when there is nothing to refresh with", async () => {
		const provider = new WorkspaceOAuthProvider({ mcpUrl: MCP_URL });
		expect(await refreshStoredSession(provider)).toBe("unavailable");
	});

	// The failure that actually bit: several Tedix processes share one
	// credentials.json, refresh tokens rotate, and presenting a superseded one
	// makes Descope invalidate the whole family. It must be named, because the
	// alternative is a full authorization that hangs in a non-interactive agent
	// until the 300s callback deadline and then blames a timeout.
	test("names a refresh-token family invalidation instead of a generic failure", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",

				accessTokenExpiresAtSeconds: 1_799_999_999,

				oauthTokens: {
					access_token: "stale-access-token",
					token_type: "Bearer",
					refresh_token: "superseded-refresh-token",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			},
		});
		const fetchFn = (async () =>
			new Response(
				JSON.stringify({
					errorCode: "E064006",
					errorDescription: "JWT family ID invalidated, cannot use this token",
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			)) as unknown as NonNullable<
			Parameters<typeof refreshStoredSession>[1]
		>["fetchFn"];

		expect(await refreshStoredSession(provider, { fetchFn })).toBe(
			"invalidated",
		);
		expect(provider.tokens()?.access_token).toBe("stale-access-token");
	});

	test("a failing authorization server leaves the stored token untouched", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",

				accessTokenExpiresAtSeconds: NOW - 1,

				oauthTokens: {
					access_token: "stale-access-token",
					refresh_token: "refresh-token",
					token_type: "Bearer",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			},
		});
		const fetchFn = (async () =>
			new Response("nope", { status: 500 })) as unknown as NonNullable<
			Parameters<typeof refreshStoredSession>[1]
		>["fetchFn"];

		// Never throws: the caller still makes the request so the server reports
		// the real problem rather than this step masking it.
		expect(await refreshStoredSession(provider, { fetchFn })).toBe("failed");
		expect(provider.tokens()?.access_token).toBe("stale-access-token");
	});

	test("bounds an unresponsive refresh request", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential: {
				loginId: "user-1",

				accessTokenExpiresAtSeconds: NOW - 1,

				oauthTokens: {
					access_token: "stale-access-token",
					refresh_token: "refresh-token",
					token_type: "Bearer",
				},
				oauthClientInformation: { client_id: "client-1" },
				oauthDiscoveryState: {
					authorizationServerUrl: "https://auth.example.test",
				},
			},
		});
		const fetchFn = (async (_input, init) =>
			await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{
						once: true,
					},
				);
			})) as NonNullable<Parameters<typeof refreshStoredSession>[1]>["fetchFn"];

		const startedAt = Date.now();
		expect(
			await refreshStoredSession(provider, { fetchFn, timeoutMs: 5 }),
		).toBe("failed");
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(SESSION_REFRESH_TIMEOUT_MS).toBe(15_000);
	});
});

describe("canonical token deadlines", () => {
	test("opaque expiry is fixed at receipt across metadata saves and reloads", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-fixed-expiry-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				workspace: "fixed",
				persist: true,
				loadStored: false,
			});
			await provider.saveTokens({
				access_token: "opaque",
				refresh_token: "opaque-refresh",
				token_type: "Bearer",
				expires_in: 600,
				issuer: ISSUER,
			});
			expect(provider.credential().accessTokenExpiresAtSeconds).toBe(
				1_800_000_600,
			);
			clock.mockReturnValue(1_800_000_500_000);
			provider.saveDiscoveryState({ authorizationServerUrl: ISSUER });
			await provider.saveClientInformation({
				client_id: "client",
				issuer: ISSUER,
			});
			const stored = readWorkspaceCredentials("fixed")!;
			expect(stored.accessTokenExpiresAtSeconds).toBe(1_800_000_600);
			expect(stored.oauthTokens?.issuer).toBe(ISSUER);
			const reloaded = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				credential: stored,
				loadStored: false,
			});
			expect(reloaded.credential().accessTokenExpiresAtSeconds).toBe(
				1_800_000_600,
			);
			expect(sessionNeedsRefresh(reloaded.credential(), 1_800_000_400)).toBe(
				false,
			);
			expect(sessionNeedsRefresh(reloaded.credential(), 1_800_000_601)).toBe(
				true,
			);
			await provider.invalidateCredentials("tokens");
			const cleared = readWorkspaceCredentials("fixed")!;
			expect(cleared.oauthTokens).toBeUndefined();
			expect(cleared.accessTokenExpiresAtSeconds).toBeUndefined();
			expect(cleared.oauthClientInformation?.client_id).toBe("client");
			expect(cleared.oauthDiscoveryState?.authorizationServerUrl).toBe(ISSUER);
			expect(
				new WorkspaceOAuthProvider({
					mcpUrl: MCP_URL,
					credential: cleared,
					loadStored: false,
				}).tokens(),
			).toBeUndefined();
		} finally {
			clock.mockRestore();
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});
	test("JWT expiry wins over duration and zero duration is already expired", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				loadStored: false,
			});
			await provider.saveTokens({
				access_token: jwt({ exp: 1_800_000_100 }),
				token_type: "Bearer",
				expires_in: 600,
				refresh_token: "r",
			});
			expect(provider.credential().accessTokenExpiresAtSeconds).toBe(
				1_800_000_100,
			);
			await provider.saveTokens({
				access_token: "opaque",
				token_type: "Bearer",
				expires_in: 0,
				refresh_token: "r",
			});
			expect(provider.credential().accessTokenExpiresAtSeconds).toBe(
				1_800_000_000,
			);
			expect(sessionNeedsRefresh(provider.credential(), 1_800_000_000)).toBe(
				true,
			);
		} finally {
			clock.mockRestore();
		}
	});
	test.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"invalid or absent duration %s remains unknown",
		async (expires_in) => {
			const provider = new WorkspaceOAuthProvider({
				mcpUrl: MCP_URL,
				loadStored: false,
			});
			await provider.saveTokens({
				access_token: "opaque",
				token_type: "Bearer",
				refresh_token: "r",
				expires_in,
			});
			expect(provider.credential().accessTokenExpiresAtSeconds).toBeUndefined();
			expect(sessionNeedsRefresh(provider.credential())).toBe(true);
		},
	);
	test("missing canonical deadline is not reconstructed from duration or stale aliases", () => {
		const credential = {
			loginId: "user",
			sessionExp: 9_999_999_999,
			oauthTokens: {
				access_token: "opaque",
				refresh_token: "r",
				token_type: "Bearer",
				expires_in: 600,
			},
		};
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			credential,
			loadStored: false,
		});
		expect(provider.credential().accessTokenExpiresAtSeconds).toBeUndefined();
		expect(sessionNeedsRefresh(provider.credential())).toBe(true);
	});
	test("no refresh token makes no provider request", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: MCP_URL,
			loadStored: false,
			credential: {
				loginId: "user",
				oauthTokens: { access_token: "opaque", token_type: "Bearer" },
			},
		});
		let calls = 0;
		await refreshStoredSession(provider, {
			fetchFn: async () => {
				calls++;
				throw new Error("unexpected network");
			},
		});
		expect(calls).toBe(0);
	});
});

describe("renewal applies login grant invariants", () => {
	const renew = async (input: {
		mcpUrl: string;
		org?: string;
		oldClaims: object;
		renewedClaims: object;
		renewedScope?: string;
	}) => {
		const oldToken = jwt(input.oldClaims);
		const stored = {
			loginId: "user-1",
			mcpUrl: input.mcpUrl,
			...(input.org ? { org: input.org } : {}),
			accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) - 1,
			oauthTokens: {
				access_token: oldToken,
				refresh_token: "refresh-token",
				scope: "mcp:apps.read",
				token_type: "Bearer",
			},
			oauthClientInformation: { client_id: "client-1" },
			oauthDiscoveryState: {
				authorizationServerUrl: "https://auth.example.test",
			},
		};
		// Renew through a real workspace so the locked re-read supplies the stored
		// organization, exactly as `refreshSession()` does.
		writeWorkspaceCredentials("renewal", stored);
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: input.mcpUrl,
			credential: stored,
		});
		provider.saveResourceUrl(input.mcpUrl);
		const fetchFn = (async (request: string | URL | Request) => {
			const url = String(request instanceof Request ? request.url : request);
			if (url.includes("/.well-known/")) {
				return Response.json({
					issuer: "https://auth.example.test",
					token_endpoint: "https://auth.example.test/token",
					response_types_supported: ["code"],
				});
			}
			return Response.json({
				access_token: jwt(input.renewedClaims),
				refresh_token: "rotated",
				scope: input.renewedScope ?? "mcp:apps.read",
				token_type: "Bearer",
			});
		}) as unknown as NonNullable<
			Parameters<typeof refreshStoredSession>[1]
		>["fetchFn"];
		const outcome = await refreshStoredSession(provider, {
			fetchFn,
			workspace: "renewal",
		});
		return {
			outcome,
			provider,
			oldToken,
			saved: readWorkspaceCredentials("renewal"),
		};
	};
	let previousConfigDir: string | undefined;
	beforeEach(() => {
		previousConfigDir = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = mkdtempSync(
			join(tmpdir(), "tedix-renewal-"),
		);
	});
	afterEach(() => {
		if (previousConfigDir === undefined) delete process.env.TEDIX_CONFIG_DIR;
		else process.env.TEDIX_CONFIG_DIR = previousConfigDir;
	});
	const connectClaims = {
		aud: TEDIX_CONNECT_MCP_URL,
		token_type: "access_token",
		dci: "client-1",
		tedixSelectedOrganizations: ["org_tedix"],
	};

	test("rejects a renewed token for a different resource", async () => {
		const { outcome, provider, oldToken } = await renew({
			mcpUrl: TEDIX_CONNECT_MCP_URL,
			oldClaims: connectClaims,
			renewedClaims: { ...connectClaims, aud: "https://other.example/mcp" },
		});
		expect(outcome).toBe("failed");
		expect(provider.tokens()?.access_token).toBe(oldToken);
		expect(provider.tokens()?.refresh_token).toBe("refresh-token");
	});

	test("rejects a renewed token that is not an access token", async () => {
		const { outcome } = await renew({
			mcpUrl: TEDIX_CONNECT_MCP_URL,
			oldClaims: connectClaims,
			renewedClaims: { ...connectClaims, token_type: "id_token" },
		});
		expect(outcome).toBe("failed");
	});

	test("rejects a renewed token for another organization", async () => {
		const { outcome, oldToken, saved } = await renew({
			mcpUrl: MCP_URL,
			org: "org_acme",
			oldClaims: { dct: "org_acme" },
			renewedClaims: { dct: "org_other" },
		});
		expect(outcome).toBe("failed");
		expect(saved?.oauthTokens?.access_token).toBe(oldToken);
		expect(saved?.org).toBe("org_acme");
	});

	test("rejects a renewed JWT whose own scope is wider than the response", async () => {
		const { outcome, provider, oldToken } = await renew({
			mcpUrl: MCP_URL,
			org: "org_acme",
			oldClaims: { dct: "org_acme" },
			renewedClaims: { dct: "org_acme", scope: "mcp:apps.read platform:admin" },
		});
		expect(outcome).toBe("scope-expanded");
		expect(provider.tokens()?.access_token).toBe(oldToken);
	});

	test("accepts an equivalent renewed token", async () => {
		const { outcome } = await renew({
			mcpUrl: MCP_URL,
			org: "org_acme",
			oldClaims: { dct: "org_acme" },
			renewedClaims: { dct: "org_acme", scope: "mcp:apps.read" },
		});
		expect(outcome).toBe("refreshed");
	});
});

test("scopesBeyondGrant reads the response and both token claim shapes", () => {
	expect(
		scopesBeyondGrant("a b", {
			responseScope: "a",
			tokenClaims: { scope: "a b" },
		}),
	).toEqual([]);
	expect(
		scopesBeyondGrant("a", { tokenClaims: { scope: "a platform:admin" } }),
	).toEqual(["platform:admin"]);
	expect(scopesBeyondGrant("a", { tokenClaims: { scp: ["a", "c"] } })).toEqual([
		"c",
	]);
	expect(scopesBeyondGrant("a", { responseScope: "a d" })).toEqual(["d"]);
	expect(scopesBeyondGrant(undefined, { responseScope: "x" })).toEqual([]);
});

describe("non-interactive scope challenges", () => {
	test("fail fast with the login command and never open a browser", async () => {
		let opened = false;
		let captured = false;
		const provider = new WorkspaceOAuthProvider({
			workspace: "ci",
			mcpUrl: MCP_URL,
			tenant: "org_acme",
			loadStored: false,
			consentPrompt: false,
			openAuthorization: () => {
				opened = true;
			},
			captureCallback: async () => {
				captured = true;
				return new URLSearchParams({ code: "code" });
			},
		});

		const failure = await provider
			.authorizeScopeChallenge("mcp:apps.read mcp:apps.write")
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(OAuthConsentRequiredError);
		const error = failure as OAuthConsentRequiredError;
		expect(error.code).toBe("insufficient_scope");
		expect(error.requiredScopes).toEqual(["mcp:apps.read", "mcp:apps.write"]);
		expect(error.loginCommand).toBe(
			`tedix login --workspace ci --url ${MCP_URL} --org org_acme --scope-profile member`,
		);
		expect(error.message).toContain(error.loginCommand);
		expect(opened).toBe(false);
		expect(captured).toBe(false);
	});

	test("guards a direct SDK redirect too", async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: TEDIX_CONNECT_MCP_URL,
			loadStored: false,
			consentPrompt: false,
			openAuthorization: () => {
				throw new Error("browser must not open");
			},
		});
		const url = new URL("https://auth.example.test/authorize");
		url.searchParams.set("scope", "mcp:apps.read");
		await expect(provider.redirectToAuthorization(url)).rejects.toBeInstanceOf(
			OAuthConsentRequiredError,
		);
	});

	test("maps required scopes to the narrowest login profile", () => {
		expect(minimalScopeProfileFor(["mcp:apps.read"])).toBe("read");
		expect(minimalScopeProfileFor(["mcp:apps.read", "mcp:apps.write"])).toBe(
			"member",
		);
		expect(minimalScopeProfileFor(["mcp:apps.admin"])).toBe("admin");
		expect(minimalScopeProfileFor(["platform:admin"])).toBe("platform-admin");
		expect(minimalScopeProfileFor([])).toBeUndefined();
	});

	test("consent prompting needs both TTYs and no CI", () => {
		expect(canPromptForConsent({}, { stdin: true, stdout: true })).toBe(true);
		expect(canPromptForConsent({}, { stdin: true, stdout: false })).toBe(false);
		expect(canPromptForConsent({}, { stdin: false, stdout: true })).toBe(false);
		expect(
			canPromptForConsent({ CI: "true" }, { stdin: true, stdout: true }),
		).toBe(false);
	});
});
