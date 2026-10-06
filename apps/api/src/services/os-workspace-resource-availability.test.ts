import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { resolveWorkspaceResourceAvailability } from "./os-workspace-resource-availability";

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
