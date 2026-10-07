import { describe, expect, it, vi } from "vite-plus/test";
import type { CallerIdentity } from "./caller-identity";
import {
	isOwnerHostEligibleCaller,
	OwnerHostSessionError,
	resolveCodeModeOwnerHostSession,
} from "./owner-host-session";

const SESSION = "00000000-0000-4000-8000-000000000020";
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const HUMAN: CallerIdentity = {
	authType: "oauth",
	userId: "descope-owner",
	organizationId: ORG,
	scopes: ["mcp:work.write"],
};

function rpcResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

function sessionBody(organizationId = ORG) {
	return {
		json: {
			session: { id: SESSION, organizationId, status: "active" },
			principal: { id: "p", key: "owner-host-abc", displayName: "Hosts" },
		},
	};
}

function apiService(handler: (request: Request) => Promise<Response>) {
	const requests: Request[] = [];
	return {
		requests,
		env: {
			API_SERVICE: {
				fetch: vi.fn(async (request: Request) => {
					requests.push(request);
					return handler(request);
				}),
			},
		} as unknown as Pick<CloudflareEnv, "API_SERVICE">,
	};
}

describe("owner-host caller eligibility", () => {
	it.each<[string, CallerIdentity, boolean]>([
		["human OAuth", HUMAN, true],
		["AIH M2M", { ...HUMAN, credentialMode: "aih-m2m" }, false],
		["tedi", { authType: "tedi", tediId: "t" }, false],
		["human on a tedi surface", { ...HUMAN, tediId: "t" }, false],
		[
			"external agent",
			{ authType: "external_agent", externalAgentPrincipalId: "p" },
			false,
		],
		["service", { authType: "service" }, false],
		["api key", { authType: "apiKey" }, false],
	])("%s", (_label, caller, expected) => {
		expect(isOwnerHostEligibleCaller(caller, "token")).toBe(expected);
	});

	it("requires the forwarded bearer token", () => {
		expect(isOwnerHostEligibleCaller(HUMAN, undefined)).toBe(false);
	});
});

describe("Code Mode agentSessionId", () => {
	it("keeps today's behaviour when absent", async () => {
		const api = apiService(async () => rpcResponse(200, sessionBody()));
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: undefined,
				caller: HUMAN,
				bearerToken: "token",
				env: api.env,
				appOrganizationId: ORG,
			}),
		).resolves.toBeUndefined();
		expect(api.requests).toHaveLength(0);
	});

	it("is ignored for non-human callers", async () => {
		const api = apiService(async () => rpcResponse(200, sessionBody()));
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: SESSION,
				caller: { ...HUMAN, credentialMode: "aih-m2m" },
				bearerToken: "token",
				env: api.env,
				appOrganizationId: ORG,
			}),
		).resolves.toBeUndefined();
		expect(api.requests).toHaveLength(0);
	});

	it("verifies a human's session as that human over the trusted hop", async () => {
		const api = apiService(async () => rpcResponse(200, sessionBody()));
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: SESSION,
				caller: HUMAN,
				bearerToken: "token",
				env: api.env,
				appOrganizationId: ORG,
			}),
		).resolves.toBe(SESSION);
		const request = api.requests[0]!;
		expect(new URL(request.url).pathname).toBe(
			"/rpc/externalAgentIdentity/resolveOwnerHostSession",
		);
		expect(request.headers.get("X-Service-Binding")).toBe("true");
		expect(request.headers.get("X-Tedix-Caller-Type")).toBe("mcp-edge-user");
		expect(request.headers.get("X-Forwarded-Authorization")).toBe(
			"Bearer token",
		);
		expect(request.headers.get("X-Tedix-Org-Id")).toBe(ORG);
		expect(request.headers.get("X-Tedix-Auth-Owner-Host-Session-Id")).toBe(
			SESSION,
		);
	});

	it("fails the call for an invalid session instead of falling back", async () => {
		const api = apiService(async () =>
			rpcResponse(401, {
				json: {
					defined: false,
					code: "UNAUTHORIZED",
					message: "not yours",
				},
			}),
		);
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: SESSION,
				caller: HUMAN,
				bearerToken: "token",
				env: api.env,
				appOrganizationId: ORG,
			}),
		).rejects.toThrow(
			new OwnerHostSessionError(
				"agentSessionId is not an active owner-host Agent-Session of the authenticated user. Start one with start_external_agent_session_for_host and pass its session id.",
			),
		);
	});

	it("reports an unavailable verifier as retryable, still without fallback", async () => {
		const api = apiService(
			async () => new Response("bad gateway", { status: 502 }),
		);
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: SESSION,
				caller: HUMAN,
				bearerToken: "token",
				env: api.env,
				appOrganizationId: ORG,
			}),
		).rejects.toThrow(/could not be verified right now/);
	});

	it("tries each verified multi-organization grant", async () => {
		const api = apiService(async (request) =>
			request.headers.get("X-Tedix-Org-Id") === OTHER_ORG
				? rpcResponse(200, sessionBody(OTHER_ORG))
				: rpcResponse(403, {
						json: {
							defined: false,
							code: "FORBIDDEN",
							message: "no",
						},
					}),
		);
		await expect(
			resolveCodeModeOwnerHostSession({
				agentSessionId: SESSION,
				caller: {
					...HUMAN,
					organizationId: undefined,
					verifiedMultiOrgOrganizations: [
						{ organizationId: ORG, descopeTenantId: "T1", gatewaySlug: "a" },
						{
							organizationId: OTHER_ORG,
							descopeTenantId: "T2",
							gatewaySlug: "b",
						},
					],
				},
				bearerToken: "token",
				env: api.env,
				appOrganizationId: undefined,
			}),
		).resolves.toBe(SESSION);
		expect(api.requests).toHaveLength(2);
	});
});
