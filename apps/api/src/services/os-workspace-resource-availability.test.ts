import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { resolveWorkspaceResourceAvailability } from "./os-workspace-resource-availability";

const mocks = vi.hoisted(() => ({
	account: {
		tokenIds: ["token-1"],
		tokenSub: "account-1",
	},
	token: {
		id: "token-1",
		tokenSub: "account-1",
		scopes: ["repo:read"],
		expiresAt: undefined as number | string | null | undefined,
	},
}));

vi.mock("@tedix/db/queries/connection-instances", () => ({
	getConnectionInstance: vi.fn(async () => mocks.account),
}));

vi.mock("../rpc/routers/connections/policy-resolution", () => ({
	fetchNamedConnection: vi.fn(async () => mocks.token),
}));

const NOW = new Date("2026-08-21T12:00:00.000Z");
const context = {
	descopeUserId: "user-1",
	user: { sub: "user-1" },
} as unknown as BaseContext;
const resource = {
	organizationId: "org-1",
	providerId: "github",
	connectionScope: "tenant" as const,
	requiredScopes: ["repo:read"],
	status: "active" as const,
};
const baseDependencies = {
	now: () => NOW,
	resolveTenantId: async () => "tenant-1",
};

describe("resolveWorkspaceResourceAvailability", () => {
	beforeEach(() => {
		mocks.token.expiresAt = undefined;
	});

	it("projects an available canonical connection without exposing its token", async () => {
		const result = await resolveWorkspaceResourceAvailability(
			context,
			resource,
			{
				...baseDependencies,
				resolveToken: async () => ({ expiresAt: 1_800_000_000 }),
			},
		);
		expect(result).toEqual({
			status: "available",
			reason: null,
			checkedAt: NOW.toISOString(),
		});
		expect(JSON.stringify(result)).not.toContain("token");
	});

	it("fails closed for missing, expired, and failed checks", async () => {
		const missing = await resolveWorkspaceResourceAvailability(
			context,
			resource,
			{
				...baseDependencies,
				resolveToken: async () => null,
			},
		);
		const expired = await resolveWorkspaceResourceAvailability(
			context,
			resource,
			{
				...baseDependencies,
				resolveToken: async () => ({ expiresAt: 1 }),
			},
		);
		const failed = await resolveWorkspaceResourceAvailability(
			context,
			resource,
			{
				...baseDependencies,
				resolveToken: async () => {
					throw new Error("provider unavailable");
				},
			},
		);
		expect(missing.status).toBe("missing_connection");
		expect(expired.status).toBe("expired_connection");
		expect(failed.status).toBe("check_failed");
	});

	it.each(["invalid", Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"fails closed for malformed tenant expiration %s",
		async (expiresAt) => {
			const result = await resolveWorkspaceResourceAvailability(
				context,
				resource,
				{
					...baseDependencies,
					resolveToken: async () => ({ expiresAt }),
				},
			);

			expect(result.status).toBe("expired_connection");
		},
	);

	it.each(["invalid", Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"fails closed for malformed personal expiration %s",
		async (expiresAt) => {
			mocks.token.expiresAt = expiresAt;
			const result = await resolveWorkspaceResourceAvailability(
				{ ...context, authType: "user" } as BaseContext,
				{
					...resource,
					connectionScope: "user",
					personalOwnerUserId: "user-1",
					connectionInstanceId: "connection-1",
				},
				{ now: () => NOW },
			);

			expect(result.status).toBe("expired_connection");
		},
	);

	it.each([undefined, null, 0])(
		"preserves non-expiring tenant expiration %s",
		async (expiresAt) => {
			const result = await resolveWorkspaceResourceAvailability(
				context,
				resource,
				{
					...baseDependencies,
					resolveToken: async () => ({ expiresAt }),
				},
			);

			expect(result.status).toBe("available");
		},
	);

	it("never resolves a removed resource", async () => {
		let checked = false;
		const result = await resolveWorkspaceResourceAvailability(
			context,
			{ ...resource, status: "removed" },
			{
				...baseDependencies,
				resolveToken: async () => {
					checked = true;
					return {};
				},
			},
		);
		expect(result.status).toBe("not_executable");
		expect(checked).toBe(false);
	});
});
