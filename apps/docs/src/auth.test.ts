import { validateToken } from "@tedix/auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { authorizeDocsRequest, delegatedDocsScope } from "./auth";
import type { AppBindings } from "./types";

vi.mock("@tedix/auth/jwt", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/jwt")>()),
	validateToken: vi.fn(),
}));

const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_BASE_URL: "https://api.descope.com",
	DESCOPE_MANAGEMENT_KEY: "management-key",
	PLATFORM_SERVICE_TOKEN: "platform-service-token",
} as AppBindings;

function serviceRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://docs.internal/mcp?org=tedix", {
		headers: {
			Authorization: "Bearer platform-service-token",
			...headers,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(validateToken).mockResolvedValue({
		sub: "descope-user",
		scope: "apps:read",
		iat: 1,
		exp: 2,
		iss: "project",
		aud: "project",
	});
});

describe("delegatedDocsScope", () => {
	it.each([
		"mcp:content.read",
		"mcp:content.write",
		"mcp:content.admin",
	] as const)("accepts the exact %s scope", (scope) => {
		expect(
			delegatedDocsScope(serviceRequest({ "X-Tedix-Delegated-Scope": scope })),
		).toBe(scope);
	});

	it.each([
		"mcp:content.read mcp:content.write",
		"mcp:content.read,mcp:content.write",
		"*",
		"platform:admin",
	])("rejects the invalid delegated value %s", (scope) => {
		expect(() =>
			delegatedDocsScope(serviceRequest({ "X-Tedix-Delegated-Scope": scope })),
		).toThrow("Invalid delegated Docs scope");
	});
});

describe("authorizeDocsRequest service delegation", () => {
	it("uses the API-delegated scope while retaining the forwarded human identity", async () => {
		const authorization = await authorizeDocsRequest(
			serviceRequest({
				"X-Forwarded-Authorization": "Bearer descope-session",
				"X-Tedix-Delegated-Scope": "mcp:content.read",
			}),
			env,
		);

		expect(validateToken).toHaveBeenCalledWith(
			"descope-session",
			expect.objectContaining({ projectId: "project" }),
		);
		expect(authorization).toMatchObject({
			orgSlug: "tedix",
			platformAdmin: false,
			scopes: ["mcp:content.read"],
			actor: { type: "user", id: "descope-user" },
		});
	});

	it("does not misclassify a human OAuth token with a client id as M2M", async () => {
		vi.mocked(validateToken).mockResolvedValueOnce({
			sub: "descope-user",
			email: "operator@example.test",
			client_id: "oauth-client",
			scope: "apps:read",
			iat: 1,
			exp: 2,
			iss: "project",
			aud: "project",
		});
		const authorization = await authorizeDocsRequest(
			serviceRequest({
				"X-Forwarded-Authorization": "Bearer human-oauth-session",
				"X-Tedix-Delegated-Scope": "mcp:content.read",
			}),
			env,
		);

		expect(authorization.actor).toMatchObject({
			type: "user",
			id: "descope-user",
		});
	});

	it("rejects delegated access when the forwarded session is invalid", async () => {
		vi.mocked(validateToken).mockRejectedValueOnce(
			new Error("Invalid Compact JWS"),
		);

		await expect(
			authorizeDocsRequest(
				serviceRequest({
					"X-Forwarded-Authorization": "Bearer invalid-session",
					"X-Tedix-Delegated-Scope": "mcp:content.read",
				}),
				env,
			),
		).rejects.toThrow("Invalid Compact JWS");
	});

	it("rejects delegation without forwarded user authorization", async () => {
		await expect(
			authorizeDocsRequest(
				serviceRequest({
					"X-Tedix-Delegated-Scope": "mcp:content.read",
				}),
				env,
			),
		).rejects.toThrow("requires forwarded authorization");
	});

	it("accepts a tedi identified by trusted actor headers with no forwarded token", async () => {
		// A tedi never carries its authority in its JWT, so apps/mcp forwards no
		// bearer for it; apps/api stamps the identity it resolved instead.
		const authorization = await authorizeDocsRequest(
			serviceRequest({
				"X-Tedix-Delegated-Scope": "mcp:content.write",
				"X-Tedix-Actor-Type": "tedi",
				"X-Tedix-Actor-Id": "tedi-cto",
			}),
			env,
		);

		expect(authorization).toMatchObject({
			orgSlug: "tedix",
			platformAdmin: false,
			scopes: ["mcp:content.write"],
			actor: { type: "tedi", id: "tedi-cto" },
		});
		expect(validateToken).not.toHaveBeenCalled();
	});

	it("carries the external-agent session on the delegated actor", async () => {
		const authorization = await authorizeDocsRequest(
			serviceRequest({
				"X-Tedix-Delegated-Scope": "mcp:content.admin",
				"X-Tedix-Actor-Type": "external_agent",
				"X-Tedix-Actor-Id": "principal-1",
				"X-Tedix-Agent-Session-Id": "session-1",
			}),
			env,
		);

		expect(authorization).toMatchObject({
			platformAdmin: true,
			scopes: ["mcp:content.admin"],
			actor: {
				type: "external_agent",
				id: "principal-1",
				sessionId: "session-1",
			},
		});
	});

	it("still rejects a delegated call whose actor headers are unusable", async () => {
		// Actor type present but unrecognized, and no forwarded token: nothing
		// attributable, so the call must not inherit the delegated scope.
		await expect(
			authorizeDocsRequest(
				serviceRequest({
					"X-Tedix-Delegated-Scope": "mcp:content.admin",
					"X-Tedix-Actor-Type": "impostor",
					"X-Tedix-Actor-Id": "whoever",
				}),
				env,
			),
		).rejects.toThrow("requires forwarded authorization");
	});

	it("rejects a bare platform service token instead of granting wildcard authority", async () => {
		await expect(authorizeDocsRequest(serviceRequest(), env)).rejects.toThrow(
			"requires a delegated Docs scope",
		);
		expect(validateToken).not.toHaveBeenCalled();
	});

	it("does not honor a delegated scope on a direct user request", async () => {
		vi.mocked(validateToken).mockResolvedValueOnce({
			sub: "descope-user",
			scope: "apps:read",
			tenants: ["org_tedix"],
			iat: 1,
			exp: 2,
			iss: "project",
			aud: "project",
		});
		const request = new Request("https://docs.internal/mcp?org=tedix", {
			headers: {
				Authorization: "Bearer descope-session",
				"X-Tedix-Delegated-Scope": "mcp:content.admin",
			},
		});

		await expect(authorizeDocsRequest(request, env)).resolves.toMatchObject({
			platformAdmin: false,
			scopes: ["apps:read"],
			actor: { type: "user", id: "descope-user" },
		});
	});
});
