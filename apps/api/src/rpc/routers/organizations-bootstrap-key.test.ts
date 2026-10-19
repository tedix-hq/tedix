import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	createApiKey: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));
vi.mock("@tedix/db/queries/api-keys", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/api-keys")>()),
	createApiKey: mocks.createApiKey,
}));
import { organizationsContractRouter } from "./organizations";
const ORG = "00000000-0000-4000-8000-000000000001";
function context(): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG,
		url: new URL("https://api/rpc/organizations/createApiKey"),
		user: { sub: "fixture-owner", permissions: ["settings:manage"], roles: [] },
		userRole: "owner",
	} as BaseContext;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOrganizationById.mockResolvedValue({ id: ORG });
	mocks.createApiKey.mockImplementation(async (_db, data) => ({
		rawKey: "fixture-only",
		apiKey: {
			id: "00000000-0000-4000-8000-000000000002",
			organizationId: ORG,
			name: data.name,
			description: null,
			keyPreview: "...fixture",
			purpose: data.purpose ?? "general",
			scopes: data.scopes ?? ["apps:read"],
			environment: "test",
			lastUsedAt: null,
			requestsThisMonth: 0,
			totalRequests: 0,
			ipAllowlist: null,
			expiresAt: data.expiresAt ?? null,
			status: "active",
			rotatedAt: null,
			rotationScheduleDays: null,
			previousKeyExpiresAt: null,
			revokedAt: null,
			revokedBy: null,
			revokeReason: null,
			metadata: null,
			createdBy: "fixture-owner",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	}));
});
describe("bootstrap API key creation", () => {
	it.each([undefined, "2000-01-01T00:00:00.000Z"])(
		"rejects missing/past expiry %s",
		async (expiresAt) => {
			const client = createRouterClient(organizationsContractRouter, {
				context: context(),
			});
			await expect(
				client.createApiKey({
					organizationId: ORG,
					name: "Bootstrap",
					purpose: "external_agent_bootstrap",
					expiresAt,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.createApiKey).not.toHaveBeenCalled();
		},
	);
	it("forces empty scopes even if administrative scopes were requested", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: context(),
		});
		const result = await client.createApiKey({
			organizationId: ORG,
			name: "Bootstrap",
			purpose: "external_agent_bootstrap",
			scopes: ["platform:admin"],
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(mocks.createApiKey).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				purpose: "external_agent_bootstrap",
				scopes: [],
			}),
		);
		expect(result.apiKey).toMatchObject({
			purpose: "external_agent_bootstrap",
			scopes: [],
		});
	});
	it("retains general key creation without an expiry", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: context(),
		});
		const result = await client.createApiKey({
			organizationId: ORG,
			name: "Existing integration",
			scopes: ["apps:read"],
		});
		expect(result.apiKey).toMatchObject({
			purpose: "general",
			scopes: ["apps:read"],
			expiresAt: null,
		});
	});
});
