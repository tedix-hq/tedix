import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RpcCallError } from "@tedix/api-client/internal";
import { validateAuth } from "./auth-helpers";
import { handleExternalAgentSessionExchange } from "./external-agent-session";

const { callRpc } = vi.hoisted(() => ({ callRpc: vi.fn() }));

vi.mock("@tedix/api-client/internal", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/api-client/internal")>();
	return {
		...actual,
		callRpc,
		serviceBindingFetch: vi.fn(() => vi.fn()),
	};
});

const ORG = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

function sessionFixture() {
	return {
		id: SESSION,
		organizationId: ORG,
		principalId: PRINCIPAL,
		externalSessionKey: "codex:session",
		harness: "codex",
		harnessVersion: "1",
		modelProvider: "openai",
		modelId: "gpt-5.6",
		modelVersion: "2026-08-06",
		identitySource: "explicit",
		status: "active",
		creditEligible: true,
		startedAt: "2026-08-06T00:00:00.000Z",
		lastSeenAt: "2026-08-06T00:00:00.000Z",
		endedAt: null,
		metadata: {},
	};
}

function request(
	headers: Record<string, string> = {},
	scopes: string[] = ["platform:admin"],
): Request {
	return new Request(
		"https://tedix-unified.mcp.tedix.dev/external-agents/session",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": "sk_bound_secret",
				...headers,
			},
			body: JSON.stringify({
				organizationId: ORG,
				principalId: PRINCIPAL,
				externalSessionKey: "codex:session",
				harness: "codex",
				harnessVersion: "1",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-08-06",
				scopes,
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			}),
		},
	);
}

describe("external-agent session exchange", () => {
	beforeEach(() => {
		callRpc.mockReset();
		callRpc.mockResolvedValueOnce(sessionFixture()).mockResolvedValueOnce({
			accessToken: "short-lived-token",
			clientRecordId: "client-record",
			expiresIn: 300,
			mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		});
	});

	it("forwards the raw key only as a trusted service-binding header", async () => {
		const response = await handleExternalAgentSessionExchange(request(), {
			API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
		});

		expect(response.status).toBe(201);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(callRpc).toHaveBeenCalledTimes(2);
		for (const call of callRpc.mock.calls) {
			const body = call[1];
			const options = call[2];
			expect(JSON.stringify(body)).not.toContain("sk_bound_secret");
			expect(options.headers).toMatchObject({
				"X-API-Key": "sk_bound_secret",
				"X-Service-Binding": "true",
				"X-Tedix-Caller-Type": "mcp-edge-external-agent-session-exchange",
			});
			expect(options.headers).not.toHaveProperty("X-Tedix-Org-Id");
		}
		expect(callRpc.mock.calls.map((call) => call[0])).toEqual([
			"externalAgentIdentity/openSession",
			"externalAgentIdentity/issueMcpCredential",
		]);
	});

	it("forwards the full exact-capability profile to credential issuance", async () => {
		const scopes = Array.from(
			{ length: 31 },
			(_, index) => `mcp:domain_${index}.read`,
		);
		const response = await handleExternalAgentSessionExchange(
			request({}, scopes),
			{ API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher },
		);

		expect(response.status).toBe(201);
		expect(callRpc.mock.calls[1]?.[1]).toMatchObject({ scopes });
	});

	it("consumes a bearer workload assertion before issuing with an internal grant", async () => {
		callRpc.mockReset();
		callRpc
			.mockResolvedValueOnce({
				session: sessionFixture(),
				grantToken: "internal-workload-grant",
			})
			.mockResolvedValueOnce({
				accessToken: "short-lived-token",
				clientRecordId: "client-record",
				expiresIn: 300,
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			});
		const response = await handleExternalAgentSessionExchange(
			request({ "X-API-Key": "", Authorization: "Bearer github-oidc-token" }),
			{ API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher },
		);

		expect(response.status).toBe(201);
		expect(callRpc.mock.calls.map((call) => call[0])).toEqual([
			"externalAgentIdentity/authorizeWorkloadSession",
			"externalAgentIdentity/issueMcpCredential",
		]);
		expect(callRpc.mock.calls[0]?.[1]).toMatchObject({
			subjectToken: "github-oidc-token",
		});
		expect(callRpc.mock.calls[1]?.[2].headers).toMatchObject({
			"X-Tedix-Caller-Type": "mcp-edge-external-agent-workload-exchange",
			"X-Tedix-External-Agent-Workload-Grant": "internal-workload-grant",
		});
		expect(JSON.stringify(callRpc.mock.calls[1])).not.toContain(
			"github-oidc-token",
		);
	});

	it("rejects alternate credential channels and unvalidated bodies", async () => {
		const authorization = await handleExternalAgentSessionExchange(
			request({ Authorization: "Bearer sk_bound_secret" }),
			{ API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher },
		);
		expect(authorization.status).toBe(401);
		expect(authorization.headers.get("Cache-Control")).toBe("no-store");

		const invalid = await handleExternalAgentSessionExchange(
			new Request("https://gateway/external-agents/session", {
				method: "POST",
				headers: { "X-API-Key": "sk_bound_secret" },
				body: "{}",
			}),
			{ API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher },
		);
		expect(invalid.status).toBe(400);
		expect(callRpc).not.toHaveBeenCalled();
	});

	it("preserves the bounded ended-session reason without exposing RPC detail", async () => {
		callRpc.mockReset();
		callRpc.mockRejectedValueOnce(
			new RpcCallError(
				"externalAgentIdentity/openSession",
				409,
				JSON.stringify({
					message: "External Agent-Session has ended and cannot be reopened",
					internal: "must-not-leak",
				}),
				"Conflict",
				undefined,
			),
		);

		const response = await handleExternalAgentSessionExchange(request(), {
			API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Session exchange rejected",
			code: "session_ended",
		});
	});

	it.each([
		["externalAgentIdentity/openSession", 403, true, true],
		["externalAgentIdentity/issueMcpCredential", 403, true, true],
		["externalAgentIdentity/openSession", 403, false, true],
		["externalAgentIdentity/openSession", 409, true, false],
		["externalAgentIdentity/authorizeWorkloadSession", 403, true, false],
	])(
		"classifies only the known credential binding rejection (%s, %s, JSON %s)",
		async (path, status, json, classified) => {
			callRpc.mockReset();
			const message =
				"Authenticated credential is not bound to this external-agent principal";
			callRpc.mockRejectedValueOnce(
				new RpcCallError(
					path,
					status,
					json
						? JSON.stringify({ message, internal: "must-not-leak" })
						: message,
					"Forbidden",
					undefined,
				),
			);
			const response = await handleExternalAgentSessionExchange(request(), {
				API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
			});
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual(
				classified
					? {
							error:
								"External-agent credential does not match the registered principal",
							code: "credential_binding_mismatch",
						}
					: { error: "Session exchange rejected" },
			);
			expect(callRpc).toHaveBeenCalledTimes(1);
		},
	);

	it("does not classify arbitrary forbidden details as a binding mismatch", async () => {
		callRpc.mockReset();
		callRpc.mockRejectedValueOnce(
			new RpcCallError(
				"externalAgentIdentity/openSession",
				403,
				JSON.stringify({
					message: "secret credential sk_private",
					internal: "private SQL",
				}),
				"Forbidden",
				undefined,
			),
		);
		const response = await handleExternalAgentSessionExchange(request(), {
			API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
		});
		expect(await response.json()).toEqual({
			error: "Session exchange rejected",
		});
	});

	it.each([
		["externalAgentIdentity/issueMcpCredential", 409, true],
		["externalAgentIdentity/openSession", 409, false],
		["externalAgentIdentity/issueMcpCredential", 403, false],
	])(
		"classifies only issuance lock contention (%s, %s)",
		async (path, status, busy) => {
			callRpc.mockReset();
			callRpc.mockRejectedValueOnce(
				new RpcCallError(
					path,
					status,
					JSON.stringify({
						message:
							"MCP credential issuance is already in progress for this session and resource",
						internal: "must-not-leak",
					}),
					"Conflict",
					undefined,
				),
			);
			const response = await handleExternalAgentSessionExchange(request(), {
				API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
			});
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual(
				busy
					? {
							error: "Credential issuance is busy; retry shortly",
							code: "credential_issuance_in_progress",
						}
					: { error: "Session exchange rejected" },
			);
		},
	);

	it("reports backend unavailability without replaying session or issuance mutations", async () => {
		callRpc.mockReset();
		callRpc.mockRejectedValueOnce(
			new RpcCallError(
				"externalAgentIdentity/openSession",
				503,
				"secret SQL",
				"Unavailable",
				undefined,
			),
		);
		const response = await handleExternalAgentSessionExchange(request(), {
			API_SERVICE: { fetch: vi.fn() } as unknown as Fetcher,
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "Session backend unavailable; retry shortly with the same session",
			code: "session_backend_unavailable",
		});
		expect(callRpc).toHaveBeenCalledTimes(1);
	});
	it("continues to reject raw sk keys as /mcp identity", async () => {
		const result = await validateAuth(
			new Request("https://tedix-unified.mcp.tedix.dev/mcp", {
				headers: { Authorization: "Bearer sk_bound_secret" },
			}),
			{} as CloudflareEnv,
			{ hostname: "tedix-unified.mcp.tedix.dev" },
		);
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(401);
	});
});
