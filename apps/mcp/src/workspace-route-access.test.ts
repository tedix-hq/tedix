import { describe, expect, it } from "vite-plus/test";
import {
	resolveWorkspaceRouteAccess,
	type WorkspaceRouteCaller,
} from "./workspace-route-access";

const base: WorkspaceRouteCaller = {
	organizationId: "org-1",
	workspaceId: "ws-1",
	authType: "tedi",
	tediId: "tedi-1",
	userId: null,
	bearerToken: null,
	scopes: ["mcp:apps.read"],
};

function lookup(statuses: number[]) {
	const seen: Record<string, string>[] = [];
	return {
		seen,
		fn: async (headers: Record<string, string>) => {
			seen.push(headers);
			return statuses[seen.length - 1] ?? 404;
		},
	};
}

describe("resolveWorkspaceRouteAccess", () => {
	it("denies a workspace the API does not show this caller", async () => {
		const api = lookup([404]);
		expect(await resolveWorkspaceRouteAccess(api.fn, base)).toBe("deny");
		expect(api.seen).toHaveLength(1);
		expect(api.seen[0]).toEqual({
			"X-Tedix-Org-Id": "org-1",
			"X-Tedix-Tedi-Scopes": "apps:read",
			"X-Tedix-Tedi-Id": "tedi-1",
		});
	});

	it("allows a workspace the organization shares", async () => {
		const api = lookup([200]);
		expect(await resolveWorkspaceRouteAccess(api.fn, base)).toBe("allow");
	});

	it("asks as the tedi, without naming a person, for a tedi caller", async () => {
		const api = lookup([200]);
		await resolveWorkspaceRouteAccess(api.fn, {
			...base,
			authType: "tedi",
			tediId: "tedi-1",
			userId: "tedi-descope-user",
		});
		expect(api.seen[0]?.["X-Tedix-Tedi-Id"]).toBe("tedi-1");
		expect(api.seen[0]).not.toHaveProperty("X-Tedix-Acting-User");
	});

	it("checks the person without borrowing their attached tedi", async () => {
		const api = lookup([200]);
		const access = await resolveWorkspaceRouteAccess(api.fn, {
			...base,
			authType: "oauth",
			tediId: "tedi-1",
			userId: "user-1",
			bearerToken: "token",
			scopes: ["mcp:apps.read"],
		});
		expect(access).toBe("allow");
		expect(api.seen).toHaveLength(1);
		expect(api.seen[0]).not.toHaveProperty("X-Tedix-Tedi-Id");
		expect(api.seen[0]).toMatchObject({
			"X-Forwarded-Authorization": "Bearer token",
			"X-Tedix-Caller-Type": "mcp-edge-user",
			"X-Tedix-Mcp-Caller-Scopes": "mcp:apps.read",
		});
	});

	it("never sends a person's token for a machine caller", async () => {
		const api = lookup([404]);
		await resolveWorkspaceRouteAccess(api.fn, {
			...base,
			bearerToken: "machine-token",
		});
		expect(api.seen).toHaveLength(1);
	});

	it("reports the API being down instead of allowing or denying", async () => {
		expect(await resolveWorkspaceRouteAccess(lookup([503]).fn, base)).toBe(
			"unavailable",
		);
		expect(
			await resolveWorkspaceRouteAccess(async () => {
				throw new Error("network");
			}, base),
		).toBe("unavailable");
	});
});

it("cannot borrow an inferred tedi or app service identity for a machine caller", async () => {
	const api = lookup([200]);
	expect(
		await resolveWorkspaceRouteAccess(api.fn, {
			...base,
			authType: "external_agent",
			userId: "owner",
			bearerToken: "machine-token",
		}),
	).toBe("deny");
	expect(api.seen).toEqual([]);
});
it("does not retry a human denial as their attached tedi", async () => {
	const api = lookup([404, 200]);
	expect(
		await resolveWorkspaceRouteAccess(api.fn, {
			...base,
			authType: "oauth",
			userId: "stranger",
			bearerToken: "token",
		}),
	).toBe("deny");
	expect(api.seen).toHaveLength(1);
});

it("does not synthesize a workspace read grant for an unscoped tedi", async () => {
	const api = lookup([200]);
	expect(
		await resolveWorkspaceRouteAccess(api.fn, { ...base, scopes: [] }),
	).toBe("deny");
	expect(api.seen).toEqual([]);
});
