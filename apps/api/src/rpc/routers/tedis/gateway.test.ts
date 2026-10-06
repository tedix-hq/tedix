import { call, os } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { issueGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import type { BaseContext } from "../../orpc";
import { withAuth } from "../../orpc";
import {
	embeddedActorCacheKey,
	portableSessionCallables,
	resolveOsPortableRoute,
	verifyOsPortableCallCapability,
	verifyOsPortableUserSession,
} from "./gateway";

describe("first-party portable relay authentication", () => {
	it("treats the API service-binding hop as service auth even when a user cookie is forwarded", async () => {
		const context = {
			url: new URL("https://api/rpc/tedis/authorizeOsPortableCall"),
			headers: new Headers({
				"X-Service-Binding": "true",
				Cookie: "DS=signed-user-session",
				"X-Tedix-Tenant-Id": "tenant-one",
			}),
			organizationId: "org-one",
			env: {},
		} as unknown as BaseContext;
		const procedure = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(({ context }) => ({
				authType: context.authType,
				user: context.user,
			}));
		await expect(call(procedure, undefined, { context })).resolves.toEqual({
			authType: "service-binding",
			user: undefined,
		});
	});

	it("independently verifies the forwarded session subject and canonical tenant", async () => {
		const verify = vi.fn(async () => ({
			sub: "user-one",
			dct: "tenant-one",
		})) as never;
		const input = {
			cookie: "DS=signed-user-session",
			projectId: "project-one",
			baseUrl: undefined,
			descopeTenantId: "tenant-one",
		};
		expect(await verifyOsPortableUserSession(input, verify)).toBe("user-one");
		expect(verify).toHaveBeenCalledWith("signed-user-session", {
			projectId: "project-one",
			baseUrl: undefined,
		});
		expect(
			await verifyOsPortableUserSession(
				{ ...input, descopeTenantId: "tenant-two" },
				verify,
			),
		).toBeNull();
		expect(
			await verifyOsPortableUserSession(
				{ ...input, cookie: "DS=one; DS=two" },
				verify,
			),
		).toBeNull();
		expect(
			await verifyOsPortableUserSession({ ...input, cookie: null }, verify),
		).toBeNull();
	});
});

describe("first-party route mint admission", () => {
	const profile = {
		version: 1 as const,
		routes: [
			{
				id: "workspace_list",
				match: { routeKey: "workspaces" },
				tools: [
					{ callable: "os.list_os_workspaces", bind: undefined },
					{ callable: "os.get_os_workspace", bind: undefined },
				],
			},
		],
	};
	const request = {
		assertion: {
			routeId: "workspace_list",
			pathname: "/workspaces",
			routeKey: "workspaces",
		},
		profile: profile as never,
		organizationSlug: "tedix",
		allowedOrigin: "https://tedix.os.tedix.dev",
		hostOrganizationId: "org-one",
		contextOrganizationId: "org-one",
		tediOrganizationId: "org-one",
		userSub: "user-one",
	};
	it("signs only the canonical untargeted route for the current organization", () => {
		expect(resolveOsPortableRoute(request)).toMatchObject({
			id: "workspace_list",
			pathname: "/workspaces",
			routeKey: "workspaces",
			bindings: { "os.list_os_workspaces": {}, "os.get_os_workspace": {} },
		});
		for (const changed of [
			{ ...request, contextOrganizationId: "org-two" },
			{ ...request, hostOrganizationId: "org-two" },
			{ ...request, allowedOrigin: "https://other.os.tedix.dev" },
			{ ...request, assertion: { ...request.assertion, pathname: "/skills" } },
			{ ...request, assertion: { ...request.assertion, routeId: "other" } },
		])
			expect(resolveOsPortableRoute(changed)).toBeNull();
	});
	it("selects the workspace route even when another route is first in the profile", () => {
		const multiple = {
			...profile,
			routes: [
				{ id: "skills", match: { routeKey: "skills" }, tools: [] },
				...profile.routes,
			],
		};
		expect(
			resolveOsPortableRoute({ ...request, profile: multiple as never }),
		).toMatchObject({ id: "workspace_list", routeKey: "workspaces" });
	});
	it("refuses a browser-supplied target until the server can verify its ownership", () => {
		const targeted = {
			...profile,
			routes: [
				{
					...profile.routes[0]!,
					tools: [
						{
							callable: "os.get_os_workspace",
							bind: { workspaceId: "$context.params.workspaceId" },
						},
					],
				},
			],
		};
		expect(
			resolveOsPortableRoute({ ...request, profile: targeted as never }),
		).toBeNull();
	});
});

describe("first-party signed portable route", () => {
	const expected = {
		secret: "portable-test-secret",
		organizationId: "org-one",
		userSub: "user-one",
	};
	const base = {
		allowedOrigin: "https://tedix.os.tedix.dev",
		expiresAt: Math.floor(Date.now() / 1000) + 120,
		secret: expected.secret,
		subject: "host:user-one",
		hostOrganizationId: expected.organizationId,
		hostUserId: expected.userSub,
		tediId: "55555555-5555-4555-8555-555555555555",
		surface: "os" as const,
		portableWebMcpCallables: ["os.list_os_workspaces", "os.get_os_workspace"],
		portableRoute: {
			id: "workspaces",
			pathname: "/workspaces",
			routeKey: "workspaces",
			bindings: { "os.list_os_workspaces": {}, "os.get_os_workspace": {} },
		},
	};
	const call = {
		routeId: "workspaces",
		callable: "os.list_os_workspaces",
		args: {},
		origin: base.allowedOrigin,
		refererPathname: "/workspaces",
	};
	it("accepts one signed route and rejects crossed route, organization, user and callable", async () => {
		const token = await issueGatewayBrowserToken(base);
		expect(
			await verifyOsPortableCallCapability({ ...call, token }, expected),
		).toBe(true);
		for (const changed of [
			{ ...call, routeId: "skills" },
			{ ...call, refererPathname: "/skills" },
			{ ...call, callable: "os.list_skills" },
			{ ...call, origin: "https://other.os.tedix.dev" },
		])
			expect(
				await verifyOsPortableCallCapability({ ...changed, token }, expected),
			).toBe(false);
		expect(
			await verifyOsPortableCallCapability(
				{ ...call, token },
				{ ...expected, organizationId: "org-two" },
			),
		).toBe(false);
		expect(
			await verifyOsPortableCallCapability(
				{ ...call, token },
				{ ...expected, userSub: "user-two" },
			),
		).toBe(false);
	});
	it("rejects forged and expired route capabilities", async () => {
		const token = await issueGatewayBrowserToken(base);
		const [header, payload, signature] = token.split(".");
		const forged = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
		expect(
			await verifyOsPortableCallCapability(
				{ ...call, token: forged },
				expected,
			),
		).toBe(false);
		const expired = await issueGatewayBrowserToken({
			...base,
			issuedAt: Math.floor(Date.now() / 1000) - 200,
			expiresAt: Math.floor(Date.now() / 1000) - 100,
		});
		expect(
			await verifyOsPortableCallCapability(
				{ ...call, token: expired },
				expected,
			),
		).toBe(false);
	});
});

describe("asserted route callable projection", () => {
	it("keeps bound reads in browser scope but out of the model tool loop", () => {
		const route = {
			id: "order_detail",
			pathname: "/orders/42",
			bindings: {
				"acme.orders_get": { orderId: "42" },
				"acme.orders_list": {},
				"acme.orders_update": { orderId: "42" },
				"acme.orders_preview_update": { orderId: "42" },
				"acme.orders_get_after_update": { orderId: "42" },
			},
		};
		const profile = {
			version: 1 as const,
			routes: [
				{
					id: "order_detail",
					match: { pathname: "/orders/:orderId" },
					tools: [
						{
							callable: "acme.orders_get",
							annotations: { readOnlyHint: true },
						},
						{
							callable: "acme.orders_list",
							annotations: { readOnlyHint: true },
						},
						{
							callable: "acme.orders_update",
							annotations: { readOnlyHint: false },
							action: {
								prepareCallable: "acme.orders_preview_update",
								convergeCallable: "acme.orders_get_after_update",
							},
						},
					],
				},
			],
		};
		const result = portableSessionCallables(profile as never, route);
		expect(result.portable).toEqual([
			"acme.orders_get",
			"acme.orders_list",
			"acme.orders_update",
			"acme.orders_preview_update",
			"acme.orders_get_after_update",
		]);
		expect(result.assistant).toEqual([]);
		expect(portableSessionCallables(profile as never).assistant).toEqual([
			"acme.orders_get",
			"acme.orders_list",
		]);
	});
});

const identity = {
	allowedOrigin: "https://staging.acme.example",
	hostOrganizationId: "1",
	hostUserId: "6190",
	tediId: "55555555-5555-4555-8555-555555555555",
};

describe("embedded actor cache key", () => {
	it("is stable, opaque, and isolated across every host identity boundary", async () => {
		const key = await embeddedActorCacheKey("test-secret", identity);
		expect(await embeddedActorCacheKey("test-secret", identity)).toBe(key);
		expect(key).toMatch(/^actor:[A-Za-z0-9_-]{32}$/);
		expect(key).not.toContain(identity.hostOrganizationId);
		expect(key).not.toContain(identity.hostUserId);

		for (const changed of [
			{ ...identity, hostUserId: "1744" },
			{ ...identity, hostOrganizationId: "8042" },
			{ ...identity, allowedOrigin: "https://app.acme.example" },
			{ ...identity, tediId: "66666666-6666-4666-8666-666666666666" },
		]) {
			expect(await embeddedActorCacheKey("test-secret", changed)).not.toBe(key);
		}
	});
});

describe("embedded session tenant fence", () => {
	const tedi = { id: "55555555-5555-4555-8555-555555555555" } as never;
	const context = {
		env: { SECRETS_MASTER_KEY: "fence-secret" },
	} as never;
	const base = {
		allowedOrigin: "https://staging.acme.example",
		conversationId: "11111111-1111-4111-8111-111111111111",
		hostOrganizationId: "8042",
		hostUserId: "6190",
	};

	it("refuses a half-specified fence instead of silently dropping it", async () => {
		const { issueEmbeddedSession } = await import("./gateway");
		// Namespace without its argument used to yield an UNFENCED session while
		// the call site plainly intended to fence one.
		await expect(
			issueEmbeddedSession(context, tedi, {
				...base,
				hostTenantNamespace: "acme_staging",
			}),
		).rejects.toThrow(/together/);
	});

	it("lets a deliberately unfenced session through the rule", async () => {
		const { issueEmbeddedSession } = await import("./gateway");
		// The OS console's own chat: unfenced on purpose, not by omission. It
		// still needs a database to finish minting, so the assertion is only that
		// the fence rule does not reject it.
		await expect(
			issueEmbeddedSession(context, tedi, {
				allowedOrigin: base.allowedOrigin,
				conversationId: base.conversationId,
				hostOrganizationId: base.hostOrganizationId,
				hostUserId: base.hostUserId,
				surface: "os",
			}),
		).rejects.not.toThrow(/together/);
	});
});
