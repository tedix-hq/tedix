// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
	handleOsRequest,
	type OsRouterEnv,
	type TenantResolver,
} from "./worker";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";

function chatEnv(role = "build", presenceWorkspaceId = workspaceId) {
	const apiRequests: Request[] = [];
	const objectRequests: Request[] = [];
	const env: OsRouterEnv = {
		ASSETS: { fetch: async () => new Response("shell") },
		API_SERVICE: {
			fetch: async (request) => {
				apiRequests.push(request);
				return Response.json({
					json: {
						workspaceId: presenceWorkspaceId,
						userId: "fictional-member",
						displayName: "Mira",
						role,
					},
				});
			},
		},
		WORKSPACE_RUNTIME: {
			fetch: async (request) => {
				objectRequests.push(request);
				return new Response("object-upgrade");
			},
		},
	};
	return { env, apiRequests, objectRequests };
}

function chatRequest() {
	return new Request(
		`https://acme.os.tedix.dev/workspace/${workspaceId}/chat?after=7`,
		{
			headers: {
				Upgrade: "websocket",
				Authorization: "Bearer fictional-session",
				"X-Workspace-Org": "spoofed-org",
				"X-Workspace-Actor-Id": "spoofed-user",
			},
		},
	);
}

describe("workspace chat organization routing", () => {
	it.each(["descope", "oidc"] as const)(
		"routes %s chat by canonical organization while keeping the authentication tenant",
		async (provider) => {
			const { env, apiRequests, objectRequests } = chatEnv();
			const resolver: TenantResolver = async () => ({
				provisioned: true,
				organizationId,
				descopeTenantId: "auth-tenant-acme",
				...(provider === "oidc" ? { identityProvider: "oidc" as const } : {}),
			});
			const response = await handleOsRequest(chatRequest(), env, resolver);
			await expect(response.text()).resolves.toBe("object-upgrade");
			expect(apiRequests[0]?.headers.get("X-Tedix-Tenant-Id")).toBe(
				provider === "oidc" ? organizationId : "auth-tenant-acme",
			);
			expect(objectRequests).toHaveLength(1);
			const forwarded = objectRequests[0]!;
			expect(forwarded.headers.get("X-Workspace-Org")).toBe(organizationId);
			expect(forwarded.headers.get("X-Workspace-Id")).toBe(workspaceId);
			expect(forwarded.headers.get("X-Workspace-Actor-Id")).toBe(
				"fictional-member",
			);
			expect(forwarded.headers.get("X-Tedix-Workspace-Role")).toBe("build");
			expect(forwarded.headers.has("Authorization")).toBe(false);
			expect(new URL(forwarded.url).searchParams.get("after")).toBe("7");
		},
	);

	it("refuses a missing canonical organization instead of addressing an auth-tenant object", async () => {
		const { env, objectRequests } = chatEnv();
		const response = await handleOsRequest(chatRequest(), env, async () => ({
			provisioned: true,
			descopeTenantId: "auth-tenant-acme",
		}));
		expect(response.status).toBe(503);
		expect(objectRequests).toHaveLength(0);
	});

	it.each([
		["use", workspaceId],
		["build", "33333333-3333-4333-8333-333333333333"],
	])(
		"refuses role %s or mismatched workspace %s",
		async (role, presenceWorkspaceId) => {
			const { env, objectRequests } = chatEnv(role, presenceWorkspaceId);
			const response = await handleOsRequest(chatRequest(), env, async () => ({
				provisioned: true,
				organizationId,
				descopeTenantId: "auth-tenant-acme",
			}));
			expect(response.status).toBe(403);
			expect(objectRequests).toHaveLength(0);
		},
	);
});
