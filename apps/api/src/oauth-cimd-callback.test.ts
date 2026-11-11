import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OutboundMcpOAuthState } from "@tedix/auth/oauth-cimd-state";
import { assertAuthorizationResponseIss } from "@tedix/auth/oauth-iss";
import {
	handleOutboundMcpOAuthCallback as relayOutboundMcpOAuthCallback,
	settleOutboundMcpOAuth,
} from "./oauth-cimd-callback";

type SettleArgs = Parameters<typeof settleOutboundMcpOAuth>;

/**
 * Settle a provider response as the person who started the flow, shaped as the
 * redirect the product page would show, so the cases below read as one flow.
 */
async function handleOutboundMcpOAuthCallback(
	request: Request,
	callbackEnv: SettleArgs[2],
	db: SettleArgs[3],
	deps: SettleArgs[4],
	caller = { userId: "user_1", organizationId: state.organizationId },
): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const result = await settleOutboundMcpOAuth(
		{
			state: params.get("state") ?? "",
			code: params.get("code"),
			iss: params.get("iss"),
			error: params.get("error"),
		},
		caller,
		callbackEnv,
		db,
		deps,
	);
	if (result.status === "rejected")
		return new Response(result.reason, {
			status: result.reason === "state_invalid" ? 400 : 403,
		});
	const target = new URL(state.redirectUrl);
	target.searchParams.set("status", result.status);
	target.searchParams.set("provider", result.provider);
	if (result.status === "error")
		target.searchParams.set("reason", result.reason);
	return Response.redirect(target.toString(), 302);
}

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

	it("settles a personal grant into the user's own vault", async () => {
		const deps = dependencies();
		deps.openState.mockResolvedValue({ ...state, userId: "user_1" });
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
		);

		const upload = deps.uploadToken.mock.calls[0]![1];
		expect(upload).toMatchObject({ userId: "user_1", grantedBy: "user_1" });
		expect(upload).not.toHaveProperty("tenantId");
		expect(deps.insertAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: expect.objectContaining({ tokenScope: "user" }),
			}),
		);
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

describe("outbound MCP CIMD relay and initiator binding", () => {
	it("relays the provider response to the product page and stores nothing", async () => {
		const openState = vi.fn().mockResolvedValue(state);
		const response = await relayOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			openState,
		);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location")!);
		expect(location.origin + location.pathname).toBe(state.redirectUrl);
		expect(location.searchParams.get("cimdState")).toBe("sealed");
		expect(location.searchParams.get("cimdCode")).toBe("code");
		expect(location.searchParams.get("cimdIss")).toBe(
			"https://auth.example.com",
		);
		expect(location.searchParams.has("status")).toBe(false);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("refuses a relay whose state cannot be authenticated", async () => {
		const response = await relayOutboundMcpOAuthCallback(
			new Request("https://api.tedix.dev/oauth/mcp/callback?state=tampered"),
			env,
			vi.fn().mockRejectedValue(new Error("bad state")),
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	});

	it.each([
		[
			"another person",
			{ userId: "user_2", organizationId: state.organizationId },
		],
		[
			"another organization",
			{
				userId: "user_1",
				organizationId: "00000000-0000-4000-8000-000000000002",
			},
		],
	])("stores nothing when %s finishes the consent", async (_label, caller) => {
		const deps = dependencies();
		const response = await handleOutboundMcpOAuthCallback(
			new Request(
				"https://api.tedix.dev/oauth/mcp/callback?state=sealed&code=code&iss=https%3A%2F%2Fauth.example.com",
			),
			env,
			{} as never,
			deps,
			caller,
		);

		expect(response.status).toBe(403);
		expect(deps.validateIssuer).not.toHaveBeenCalled();
		expect(deps.exchangeCode).not.toHaveBeenCalled();
		expect(deps.uploadToken).not.toHaveBeenCalled();
		expect(deps.insertAudit).not.toHaveBeenCalled();
	});
});
