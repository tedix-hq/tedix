import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	buildMcpLoginPageURL,
	DEFAULT_CIMD_DOMAIN_POLICIES,
	exchangeAihClientCredentials,
	hardenDescopeMcpServerRegistration,
	registerDescopeMcpResource,
} from "./aih-client";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const env = {
	DESCOPE_PROJECT_ID: "P123",
};

describe("AIH MCP server registration hardening", () => {
	it("builds the canonical Tedix BYOS consent URL", () => {
		expect(buildMcpLoginPageURL()).toBe("https://os.tedix.dev/oauth/consent");
	});

	it("hardens DCR to NOT inherit approved scopes and honors DCR opt-out", () => {
		const hardened = hardenDescopeMcpServerRegistration(
			{
				id: "server-id",
				name: "Tedix Unified",
				dynamicRegistration: {
					// Explicit opt-out: caller prefers CIMD as primary.
					enabled: false,
					flowId: "sign-up-or-in",
					disableApprovedScopesAsDefault: false,
				},
			},
			env,
		);

		expect(hardened.dynamicRegistration).toEqual({
			// Opt-out preserved.
			enabled: false,
			flowId: "sign-up-or-in",
			// Least-privilege: DCR clients no longer auto-inherit the approved envelope.
			disableApprovedScopesAsDefault: true,
		});
		expect(hardened.cimdSettings).toEqual({
			enabled: true,
			domainPolicies: {
				policies: DEFAULT_CIMD_DOMAIN_POLICIES,
			},
		});
		expect(hardened.loginPageURL).toBe("https://os.tedix.dev/oauth/consent");
	});

	it("defaults DCR enabled when unset, still hardened to disable scope defaults", () => {
		const hardened = hardenDescopeMcpServerRegistration(
			{ id: "server-id", name: "Tedix Unified" },
			env,
		);

		expect(hardened.dynamicRegistration).toEqual({
			enabled: true,
			flowId: "",
			disableApprovedScopesAsDefault: true,
		});
	});

	it("repairs a non-canonical login page and preserves the registration assessment flow", () => {
		const hardened = hardenDescopeMcpServerRegistration(
			{
				id: "server-id",
				name: "Custom",
				loginPageURL: "https://auth.tedix.dev/login/P123?flow=sign-up-or-in",
				dynamicRegistration: {
					enabled: true,
					flowId: "legacy",
				},
			},
			env,
		);

		expect(hardened.loginPageURL).toBe("https://os.tedix.dev/oauth/consent");
		expect(hardened.dynamicRegistration?.enabled).toBe(true);
		expect(hardened.dynamicRegistration?.flowId).toBe("legacy");
		expect(hardened.dynamicRegistration?.disableApprovedScopesAsDefault).toBe(
			true,
		);
	});

	it("preserves only the exact legacy multi-organization consent URL", () => {
		const legacy = "https://os.tedix.dev/oauth/consent?mode=multi-org";
		const allowed = hardenDescopeMcpServerRegistration(
			{
				id: "connect-server",
				name: "Tedix Connect",
				loginPageURL: legacy,
			},
			env,
		);
		expect(allowed.loginPageURL).toBe(legacy);

		for (const variant of [
			"https://os.tedix.dev/oauth/consent?mode=multi-org&extra=1",
			"https://os.tedix.dev/oauth/consent?mode=multi-org#fragment",
			"https://os.tedix.dev:443/oauth/consent?mode=multi-org",
			"https://evil.example/oauth/consent?mode=multi-org",
		]) {
			expect(
				hardenDescopeMcpServerRegistration(
					{
						id: "connect-server",
						name: "Tedix Connect",
						loginPageURL: variant,
					},
					env,
				).loginPageURL,
			).toBe("https://os.tedix.dev/oauth/consent");
		}
	});

	it("retains token exchange retry on transient 5xx (idempotent issuance)", async () => {
		// client_credentials issuance is stateless-safe to retry, so a transient
		// Descope 5xx must be retried instead of surfacing as a raw failure
		// (previously idempotent: false limited retries to 429 only).
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("upstream boom", { status: 502 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ access_token: "tok-123", expires_in: 60 }),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetch);

		const result = await exchangeAihClientCredentials(
			env,
			"https://example.com/mcp",
			"client-1",
			"secret-1",
		);

		expect(result).toEqual({ accessToken: "tok-123", expiresIn: 60 });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenLastCalledWith(
			"https://api.descope.com/oauth2/v1/apps/token",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "grant_type=client_credentials&client_id=client-1&client_secret=secret-1&resource=https%3A%2F%2Fexample.com%2Fmcp",
			}),
		);
	});

	it("enforces managed CIMD domains while preserving custom policies", () => {
		const hardened = hardenDescopeMcpServerRegistration(
			{
				id: "server-id",
				name: "Custom",
				cimdSettings: {
					domainPolicies: {
						policies: [
							{ domainPattern: "claude.ai", enabled: false },
							{ domainPattern: "client.example", enabled: true },
						],
					},
				},
			},
			env,
		);

		expect(hardened.cimdSettings).toEqual({
			enabled: true,
			domainPolicies: {
				policies: [
					...DEFAULT_CIMD_DOMAIN_POLICIES,
					{ domainPattern: "client.example", enabled: true },
				],
			},
		});
	});

	it("defaults to a minimal read-only approved scope when none is supplied", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetch = vi
			.fn()
			.mockImplementation((_url: string, init: RequestInit) => {
				capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
				return Promise.resolve(
					new Response(
						JSON.stringify({
							resource: {
								id: "RS1",
								name: "Minimal",
								uri: "https://x.mcp.tedix.dev/mcp",
								type: "mcp",
							},
						}),
						{ status: 200 },
					),
				);
			});
		vi.stubGlobal("fetch", fetch);

		await registerDescopeMcpResource(
			{ DESCOPE_PROJECT_ID: "P123", DESCOPE_MANAGEMENT_KEY: "management-key" },
			{ name: "Minimal", audienceWhitelist: ["https://x.mcp.tedix.dev/mcp"] },
		);

		expect(capturedBody?.scopes).toEqual({
			connectionsScopes: [
				{ name: "tedi:read", description: "Read-only tedi access" },
			],
		});
		// And DCR is hardened to not inherit those scopes as a default grant.
		expect(
			(
				(capturedBody?.dynamicRegistrationSettings as Record<string, unknown>)
					?.dynamicRegistration as Record<string, unknown>
			)?.disableApprovedScopesAsDefault,
		).toBe(true);
	});

	it("rejects the legacy multi-audience model for current Resources", async () => {
		await expect(
			registerDescopeMcpResource(
				{
					DESCOPE_PROJECT_ID: "P123",
					DESCOPE_MANAGEMENT_KEY: "management-key",
				},
				{
					name: "Ambiguous",
					audienceWhitelist: [
						"https://x.mcp.tedix.dev/mcp",
						"https://x.mcp.tedix.tech/mcp",
					],
				},
			),
		).rejects.toThrow(/exactly one canonical URI/);
	});

	it("rejects an MCP server without an exact audience", async () => {
		await expect(
			registerDescopeMcpResource(
				{
					DESCOPE_PROJECT_ID: "P123",
					DESCOPE_MANAGEMENT_KEY: "management-key",
				},
				{ name: "No audience", audienceWhitelist: [] },
			),
		).rejects.toThrow(/at least one exact audience/);
	});
});
