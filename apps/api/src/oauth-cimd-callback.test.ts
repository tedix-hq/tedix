import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OutboundMcpOAuthState } from "@tedix/auth/oauth-cimd-state";
import { assertAuthorizationResponseIss } from "@tedix/auth/oauth-iss";
import { handleOutboundMcpOAuthCallback } from "./oauth-cimd-callback";

const state: OutboundMcpOAuthState = {
	v: 1,
	appId: "provider",
	organizationId: "00000000-0000-4000-8000-000000000001",
	tenantId: "org_tedix",
	grantedBy: "user_1",
	expectedIssuer: "https://auth.example.com",
	issSupported: true,
	tokenUrl: "https://auth.example.com/token",
	resource: "https://mcp.example.com/mcp",
	redirectUrl: "https://os.tedix.dev/oauth/callback",
	codeVerifier: "v".repeat(43),
	scopes: ["mcp:tools"],
	exp: 2_000_000_000,
};

function dependencies() {
	return {
		openState: vi.fn().mockResolvedValue(state),
		validateIssuer: vi.fn(),
		exchangeCode: vi.fn().mockResolvedValue({
			accessToken: "access-secret",
			refreshToken: "refresh-secret",
			accessTokenType: "Bearer",
			scopes: ["mcp:tools"],
		}),
		uploadToken: vi.fn(),
		insertAudit: vi.fn(),
	};
}

const env = {
	SECRETS_MASTER_KEY: "secret",
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "management",
	DESCOPE_BASE_URL: "https://descope.example.com",
};

describe("outbound MCP CIMD callback", () => {
	afterEach(() => vi.restoreAllMocks());

	it("validates iss before exchange and settles into the tenant vault", async () => {
		const deps = dependencies();
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		expect(deps.validateIssuer).toHaveBeenCalledBefore(deps.exchangeCode);
		expect(deps.exchangeCode).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "code",
				codeVerifier: state.codeVerifier,
				resource: state.resource,
			}),
		);
		expect(deps.uploadToken).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				tenantId: "org_tedix",
				accessToken: "access-secret",
				grantedBy: "user_1",
				scopes: ["mcp:tools"],
			}),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("status=success");
	});

	it("never exchanges a code after issuer validation rejects", async () => {
		const deps = dependencies();
		deps.validateIssuer.mockImplementation(assertAuthorizationResponseIss);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fevil.example.com%2Foauth-query-secret",
			),
			env,
			{} as never,
			deps,
		);
		expect(deps.exchangeCode).not.toHaveBeenCalled();
		expect(deps.uploadToken).not.toHaveBeenCalled();
		expect(deps.insertAudit).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				action: "connection.oauth_cimd_failed",
				metadata: { stage: "issuer_validation" },
			}),
		);
		expect(response.headers.get("location")).toContain(
			"reason=issuer_validation_failed",
		);
		expect(logged).toHaveBeenCalledWith(
			expect.objectContaining({
				component: "api.oauth-cimd-callback",
				stage: "issuer_validation",
				issuerReason: "iss_mismatch",
				exception: { type: "UnknownThrown" },
			}),
		);
		expect(JSON.stringify(logged.mock.calls)).not.toContain(
			"oauth-query-secret",
		);
		expect(JSON.stringify(logged.mock.calls)).not.toContain("provider");
	});

	it("omits scopes when neither discovery nor the token response supplies them", async () => {
		const deps = dependencies();
		deps.openState.mockResolvedValue({ ...state, scopes: [] });
		deps.exchangeCode.mockResolvedValue({
			accessToken: "access-secret",
			accessTokenType: "Bearer",
		});
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		expect(deps.uploadToken).toHaveBeenCalledOnce();
		const upload = deps.uploadToken.mock.calls[0]![1];
		expect(upload).not.toHaveProperty("scopes");
		expect(deps.insertAudit).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				action: "connection.oauth_cimd_granted",
				metadata: expect.objectContaining({ scopeCount: 0 }),
			}),
		);
		expect(response.headers.get("location")).toContain("status=success");
	});

	it("records token exchange failures without attempting a vault upload", async () => {
		const deps = dependencies();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		deps.exchangeCode.mockRejectedValue(
			new Error("access-secret", { cause: new TypeError("refresh-secret") }),
		);
		deps.insertAudit.mockRejectedValue(new Error("audit-secret"));
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		expect(deps.uploadToken).not.toHaveBeenCalled();
		expect(deps.insertAudit).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				action: "connection.oauth_cimd_failed",
				metadata: { stage: "token_exchange" },
			}),
		);
		expect(response.headers.get("location")).toContain(
			"reason=token_exchange_failed",
		);
		expect(logged).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "token_exchange",
				exception: { type: "Error", cause: { type: "TypeError" } },
			}),
		);
		expect(logged).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "failure_audit",
				exception: { type: "Error" },
			}),
		);
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(
			/access-secret|refresh-secret|audit-secret|provider/,
		);
	});

	it("records vault upload failures separately from token exchange", async () => {
		const deps = dependencies();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		deps.uploadToken.mockRejectedValue(new Error("vault rejected"));
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		expect(deps.exchangeCode).toHaveBeenCalledOnce();
		expect(deps.insertAudit).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				action: "connection.oauth_cimd_failed",
				metadata: { stage: "vault_upload" },
			}),
		);
		expect(response.headers.get("location")).toContain(
			"reason=vault_upload_failed",
		);
		expect(logged).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "vault_upload",
				exception: { type: "Error" },
			}),
		);
	});

	it("keeps a stored grant successful when only its audit write fails", async () => {
		const deps = dependencies();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		deps.insertAudit.mockRejectedValue(new Error("audit unavailable"));
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		expect(deps.uploadToken).toHaveBeenCalledOnce();
		expect(response.headers.get("location")).toContain("status=success");
		expect(logged).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "granted_audit",
				exception: { type: "Error" },
			}),
		);
	});

	it("validates issuer on an upstream error response before accepting denial", async () => {
		const deps = dependencies();
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&error=access_denied&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);
		expect(deps.validateIssuer).toHaveBeenCalledOnce();
		expect(deps.exchangeCode).not.toHaveBeenCalled();
		expect(deps.insertAudit).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ action: "connection.oauth_cimd_denied" }),
		);
		expect(response.headers.get("location")).toContain("reason=consent_denied");
	});

	it("rejects state that cannot be authenticated", async () => {
		const deps = dependencies();
		deps.openState.mockRejectedValue(new Error("tampered"));
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=tampered&code=code",
			),
			env,
			{} as never,
			deps,
		);
		expect(response.status).toBe(400);
		expect(deps.exchangeCode).not.toHaveBeenCalled();
	});
});
