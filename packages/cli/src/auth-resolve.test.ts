import { writeWorkspaceCredentials } from "./credential-store";
import { parseOptions } from "./options";
import { validatedLoginTenant } from "./oauth-tenant";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExternalAgentProfile } from "./external-agent-store";
import { printAuthStatus, resolveAuth, jwtSummary } from "./auth-resolve";
import { TEDIX_OAUTH_CLIENT_ID } from "./oauth-provider";
import {
	requireExplicitTedixLoginTenant,
	resolveStoredLoginAuth,
	usesRetiredTedixOAuthClient,
} from "./auth-resolve";

describe("tenant-targeted login validation", () => {
	test("requires a tenant for an explicit Tedix gateway", () => {
		expect(() =>
			requireExplicitTedixLoginTenant({
				isTedixHosted: true,
				urlExplicit: true,
			}),
		).toThrow("requires `--org <organization-id>`");
		expect(() =>
			requireExplicitTedixLoginTenant({
				isTedixHosted: true,
				urlExplicit: true,
				expectedTenant: "org_tedix",
			}),
		).not.toThrow();
		expect(() =>
			requireExplicitTedixLoginTenant({
				isTedixHosted: false,
				urlExplicit: true,
			}),
		).not.toThrow();
	});

	test("rejects tenantless and wrong-tenant Tedix tokens", () => {
		expect(() =>
			validatedLoginTenant({
				isTedixHosted: true,
				expectedTenant: "org_tedix",
				tokenClaims: {
					azp: "tedix-cli",
					tenants: { org_other: {} },
					token_type: "access_token",
				},
			}),
		).toThrow("no signed membership");
		expect(() =>
			validatedLoginTenant({
				isTedixHosted: true,
				expectedTenant: "org_tedix",
				tokenClaims: {
					dct: "org_other",
					tenants: { org_tedix: {} },
				},
			}),
		).toThrow("returned tenant org_other");
	});

	test("binds a tenantless AIH access token to the selected signed membership", () => {
		expect(
			validatedLoginTenant({
				isTedixHosted: true,
				expectedTenant: "org_tedix",
				tokenClaims: {
					azp: "tedix-cli",
					tenants: { org_tedix: {} },
					token_type: "access_token",
				},
			}),
		).toBe("org_tedix");
	});

	test("returns the token tenant and preserves third-party compatibility", () => {
		expect(
			validatedLoginTenant({
				isTedixHosted: true,
				expectedTenant: "org_tedix",
				tokenClaims: { dct: "org_tedix" },
			}),
		).toBe("org_tedix");
		expect(
			validatedLoginTenant({
				isTedixHosted: false,
				expectedTenant: "custom-tenant",
			}),
		).toBe("custom-tenant");
	});
});

describe("usesRetiredTedixOAuthClient", () => {
	test("requires reauthorization for a retired client on the static Tedix resource", () => {
		expect(
			usesRetiredTedixOAuthClient({
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				storedClientId: "retired-client",
			}),
		).toBe(true);
	});

	test("requires tenant gateways to migrate from per-login DCR to CIMD", () => {
		expect(
			usesRetiredTedixOAuthClient({
				mcpUrl: "https://acme-unified.mcp.tedix.dev/mcp",
				storedClientId: "dynamic-client",
			}),
		).toBe(true);
	});

	test("keeps the verified client and external authorization servers", () => {
		expect(
			usesRetiredTedixOAuthClient({
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				storedClientId: TEDIX_OAUTH_CLIENT_ID,
			}),
		).toBe(false);
		expect(
			usesRetiredTedixOAuthClient({
				mcpUrl: "https://mcp.example.com/mcp",
				storedClientId: "dynamic-client",
			}),
		).toBe(false);
	});
});

describe("stored login renewal", () => {
	test("fails fast instead of entering interactive OAuth after refresh failure", async () => {
		const result = await resolveStoredLoginAuth("tedix", {
			credential: {
				loginId: "user-1",

				oauthTokens: {
					token_type: "Bearer",
					access_token: "expired-access-token",
					refresh_token: "refresh-token",
				},
				accessTokenExpiresAtSeconds: 1,
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				org: "org_tedix",
				oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
			},
			refreshSession: async () => "failed",
		});

		expect(result.auth).toBeNull();
		expect(result.loginError).toContain("could not be refreshed (failed)");
		expect(result.loginError).toContain("tedix login --workspace tedix");
	});

	test("returns the stored provider after successful proactive renewal", async () => {
		const result = await resolveStoredLoginAuth("tedix", {
			credential: {
				loginId: "user-1",

				oauthTokens: {
					token_type: "Bearer",
					access_token: "expired-access-token",
					refresh_token: "refresh-token",
				},
				accessTokenExpiresAtSeconds: 1,
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				org: "org_tedix",
				oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
			},
			refreshSession: async () => "refreshed",
		});

		expect(result.loginError).toBeUndefined();
		expect(result.auth?.source).toBe("stored-login:tedix");
	});

	// `not-needed` means a SIBLING process held the cross-process renewal lock
	// and completed the renewal, so the credential on disk is already fresh and
	// this process adopted its result. Refusing it sent the operator to `tedix
	// login` while their session was perfectly valid.
	test("accepts a renewal a sibling process already completed", async () => {
		const result = await resolveStoredLoginAuth("tedix", {
			credential: {
				loginId: "user-1",

				oauthTokens: {
					token_type: "Bearer",
					access_token: "expired-access-token",
					refresh_token: "refresh-token",
				},
				accessTokenExpiresAtSeconds: 1,
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				org: "org_tedix",
				oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
			},
			refreshSession: async () => "not-needed",
		});

		expect(result.loginError).toBeUndefined();
		expect(result.auth?.source).toBe("stored-login:tedix");
	});

	// The outcomes that genuinely cannot proceed must still fail fast, or the
	// expired token reaches the MCP SDK and its 401 recovery opens interactive
	// authorization — which in a non-interactive agent just hangs until the
	// five-minute loopback deadline.
	test("still fails fast on outcomes that cannot proceed", async () => {
		for (const outcome of ["unavailable", "invalidated", "failed"] as const) {
			const result = await resolveStoredLoginAuth("tedix", {
				credential: {
					loginId: "user-1",

					oauthTokens: {
						token_type: "Bearer",
						access_token: "expired-access-token",
						refresh_token: "refresh-token",
					},
					accessTokenExpiresAtSeconds: 1,
					mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
					org: "org_tedix",
					oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
				},
				refreshSession: async () => outcome,
			});
			expect(result.auth, outcome).toBeNull();
			expect(result.loginError, outcome).toContain(
				`could not be refreshed (${outcome})`,
			);
		}
	});
});

const bindingDirs: string[] = [];
const bindingEnv = [
	"TEDIX_CONFIG_DIR",
	"TEDIX_AGENT_SESSION",
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
	"TEDIX_WORKSPACE",
] as const;

afterEach(() => {
	for (const dir of bindingDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * End-to-end proof of the cross-organization guard: the shared workspace
 * selection can move underneath a running session, and `resolveAuth` must
 * refuse rather than authenticate against the workspace it drifted to.
 */
describe("resolveAuth session/workspace binding", () => {
	function bindSessionTo(workspace: string) {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-auth-binding-"));
		bindingDirs.push(configDir);
		writeExternalAgentProfile(
			workspace,
			{
				organizationId: "org-id",
				principalId: "principal-id",
				key: "claude-code-example",
				displayName: "Agent",
				apiKeyId: "api-key-id",
				rawApiKey: "sk_secret",
				scopes: ["platform:admin"],
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				createdAt: "2026-07-22T00:00:00.000Z",
				sessions: {
					"claude-code:s1": {
						id: "session-id",
						externalSessionKey: "claude-code:s1",
						harness: "claude-code",
						harnessVersion: "1.0.0",
						modelProvider: "anthropic",
						modelId: "claude-opus-5",
						modelVersion: "claude-opus-5",
						startedAt: "2026-07-22T00:00:00.000Z",
					},
				},
			},
			{ configDir },
		);
		return configDir;
	}

	async function withEnv(
		values: Partial<Record<(typeof bindingEnv)[number], string>>,
		run: () => Promise<void>,
	) {
		const saved = new Map(bindingEnv.map((k) => [k, process.env[k]]));
		for (const key of bindingEnv) delete process.env[key];
		for (const [key, value] of Object.entries(values)) {
			process.env[key] = value;
		}
		try {
			await run();
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test("refuses when the resolved workspace is not the session's", async () => {
		const configDir = bindSessionTo("acme-chat-recovery");
		await withEnv(
			{ TEDIX_CONFIG_DIR: configDir, TEDIX_AGENT_SESSION: "claude-code:s1" },
			async () => {
				const error = await resolveAuth({} as never).then(
					() => null,
					(caught: unknown) => caught as Error,
				);
				expect(error).toBeInstanceOf(Error);
				expect(error?.message).toContain("acme-chat-recovery");
				expect(error?.message).toContain("claude-code:s1");
			},
		);
	});

	test("an explicit workspace is never second-guessed", async () => {
		const configDir = bindSessionTo("acme-chat-recovery");
		await withEnv(
			{ TEDIX_CONFIG_DIR: configDir, TEDIX_AGENT_SESSION: "claude-code:s1" },
			async () => {
				const error = await resolveAuth({ workspace: "tedix" } as never).then(
					() => null,
					(caught: unknown) => caught as Error,
				);
				// It may still fail for lack of a login, but never for drift.
				expect(error?.message ?? "").not.toContain("was started in");
			},
		);
	});

	test("no Agent-Session means no binding to violate", async () => {
		const configDir = bindSessionTo("acme-chat-recovery");
		await withEnv({ TEDIX_CONFIG_DIR: configDir }, async () => {
			const error = await resolveAuth({} as never).then(
				() => null,
				(caught: unknown) => caught as Error,
			);
			expect(error?.message ?? "").not.toContain("was started in");
		});
	});
});

test("tokenless canonical state cannot select stored login or resurrect alias authority", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "tedix-tokenless-status-"));
	bindingDirs.push(configDir);
	const saved = Object.fromEntries(
		bindingEnv.map((key) => [key, process.env[key]]),
	);
	const output = spyOn(console, "log").mockImplementation(() => {});
	try {
		for (const key of bindingEnv) delete process.env[key];
		process.env.TEDIX_CONFIG_DIR = configDir;
		const stale = {
			loginId: "user",
			mcpUrl: "https://unused.example/mcp",
			sessionJwt: "stale",
			refreshJwt: "stale",
			oauthClientInformation: { client_id: "client" },
		};
		writeWorkspaceCredentials("empty", stale);
		let refreshCalls = 0;
		expect(
			await resolveStoredLoginAuth("empty", {
				refreshSession: async () => {
					refreshCalls++;
					return "failed";
				},
			}),
		).toEqual({ auth: null });
		expect(refreshCalls).toBe(0);
		const { options } = parseOptions(["--json", "--workspace", "empty"]);
		await printAuthStatus(options);
		const status = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
		expect(status.wouldUse).toBe("none");
		expect(status.storedLogin.accessToken).toBeNull();
		expect(status.mcpUrl).toBe(options.url);
	} finally {
		output.mockRestore();
		for (const key of bindingEnv) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("auth status reports token authority without inferring account eligibility", () => {
	const token = (claims: object) =>
		`eyJ.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
	expect(
		jwtSummary(token({ sub: "user-1", scope: "mcp:apps.admin" })),
	).toMatchObject({
		sub: "user-1",
		roles: [],
		scopes: ["mcp:apps.admin"],
		platformAdministration: false,
	});
	expect(jwtSummary(token({ scope: "platform:admin" }))).toMatchObject({
		platformAdministration: true,
	});
	expect(jwtSummary(token({ roles: ["platform-admin"] }))).toMatchObject({
		platformAdministration: true,
	});
	expect(
		jwtSummary(token({ tenants: { org: { roles: ["platform-admin"] } } })),
	).toMatchObject({ platformAdministration: false });
});
