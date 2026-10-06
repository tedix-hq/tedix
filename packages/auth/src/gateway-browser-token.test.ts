import { describe, expect, it } from "vite-plus/test";

import {
	assertSignedPortableRouteCall,
	type GatewayBrowserTokenError,
	issueGatewayBrowserToken,
	verifyGatewayBrowserToken,
} from "./gateway-browser-token";

describe("signed provider route", () => {
	const route = {
		id: "order_detail",
		pathname: "/orders/42",
		entity: { type: "order", id: "42" },
		bindings: {
			"acme.orders_get": { orderId: "42" },
			"acme.orders_update": { orderId: "42" },
			"acme.orders_preview_update": { orderId: "42" },
			"acme.orders_get_after_update": { orderId: "42" },
		},
	};

	it("round-trips the exact route and denies cross-route or cross-target calls", async () => {
		const token = await issueGatewayBrowserToken({
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			secret: "route-secret",
			subject: "host:operator",
			tediId: "tedi_route",
			portableWebMcpCallables: Object.keys(route.bindings),
			portableRoute: route,
		});
		const claims = await verifyGatewayBrowserToken(token, {
			expectedTediId: "tedi_route",
			secret: "route-secret",
		});
		expect(claims.portableRoute).toEqual(route);
		expect(() =>
			assertSignedPortableRouteCall(route, "acme.orders_get", {
				orderId: "42",
			}),
		).not.toThrow();
		for (const callable of [
			"acme.orders_update",
			"acme.orders_preview_update",
			"acme.orders_get_after_update",
		])
			expect(() =>
				assertSignedPortableRouteCall(route, callable, { orderId: "43" }),
			).toThrow(/route or target mismatch/);
		expect(() =>
			assertSignedPortableRouteCall(route, "acme.other_route", {
				orderId: "42",
			}),
		).toThrow(/route or target mismatch/);
		expect(() =>
			assertSignedPortableRouteCall(route, "acme.orders_get", {}),
		).toThrow(/route or target mismatch/);
	});

	it("rejects an expired route assertion with its browser token", async () => {
		const token = await issueGatewayBrowserToken({
			expiresAt: Math.floor(Date.now() / 1000) - 1,
			issuedAt: Math.floor(Date.now() / 1000) - 60,
			secret: "route-secret",
			subject: "host:operator",
			tediId: "tedi_route",
			portableRoute: route,
		});
		await expect(
			verifyGatewayBrowserToken(token, {
				expectedTediId: "tedi_route",
				secret: "route-secret",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	});
});

describe("gateway browser tokens", () => {
	it("issues a scoped short-lived token for one tedi", async () => {
		const token = await issueGatewayBrowserToken({
			allowedOrigin: "https://www.acme.example",
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			hostOrganizationId: "367",
			hostOrganizationLabel: "Acme Workshop",
			hostRole: "Administrador",
			hostTenantArgument: "companyId",
			hostTenantNamespace: "acme_staging",
			hostUserId: "1743",
			hostUserLabel: "Dana Acme · demo@acme.example",
			hostConversationContext: {
				kind: "host_record",
				reference: "vehicle-42",
				label: "2019 Transit",
			},
			providerAppId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			providerInstallationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			embeddedAssistantCallables: ["work.list_work_items"],
			issuedAt: 1_000,
			secret: "test-secret",
			sessionKey: "embed:opaque-conversation",
			subject: "user_123",
			tediId: "tedi_123",
			tenantId: "org_tedix",
		});

		const claims = await verifyGatewayBrowserToken(token, {
			expectedTediId: "tedi_123",
			expectedTenantId: "org_tedix",
			secret: "test-secret",
		});

		expect(claims).toMatchObject({
			allowedOrigin: "https://www.acme.example",
			hostOrganizationId: "367",
			hostOrganizationLabel: "Acme Workshop",
			hostRole: "Administrador",
			hostTenantArgument: "companyId",
			hostTenantNamespace: "acme_staging",
			hostUserId: "1743",
			hostUserLabel: "Dana Acme · demo@acme.example",
			hostConversationContext: {
				kind: "host_record",
				reference: "vehicle-42",
				label: "2019 Transit",
			},
			providerAppId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			providerInstallationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			embeddedAssistantCallables: ["work.list_work_items"],
			scope: "gateway:ws",
			sessionKey: "embed:opaque-conversation",
			sub: "user_123",
			tediId: "tedi_123",
			tenantId: "org_tedix",
			typ: "tedix.gateway.browser",
		});
	});

	it("rejects a token scoped to another tedi", async () => {
		const token = await issueGatewayBrowserToken({
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			secret: "test-secret",
			subject: "user_123",
			tediId: "tedi_123",
			tenantId: "org_tedix",
		});

		await expect(
			verifyGatewayBrowserToken(token, {
				expectedTediId: "tedi_other",
				expectedTenantId: "org_tedix",
				secret: "test-secret",
			}),
		).rejects.toMatchObject({
			code: "TEDI_SCOPE_MISMATCH",
		} satisfies Partial<GatewayBrowserTokenError>);
	});

	it("rejects a token scoped to another tenant", async () => {
		const token = await issueGatewayBrowserToken({
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			secret: "test-secret",
			subject: "user_123",
			tediId: "tedi_123",
			tenantId: "org_tedix",
		});

		await expect(
			verifyGatewayBrowserToken(token, {
				expectedTediId: "tedi_123",
				expectedTenantId: "org_other",
				secret: "test-secret",
			}),
		).rejects.toMatchObject({
			code: "TENANT_SCOPE_MISMATCH",
		} satisfies Partial<GatewayBrowserTokenError>);
	});
});

describe("embedded provider assertions", () => {
	it("binds the opaque provider assertion while rejecting invalid audience and expiry", async () => {
		const now = Math.floor(Date.now() / 1000);
		const base = {
			secret: "test-secret",
			subject: "host:42",
			tediId: "worker",
			tenantId: "tenant",
			expiresAt: now + 60,
		};
		const hostDelegation = {
			token: "opaque.provider.assertion",
			audience: "https://api.example.com",
			expiresAt: now + 60,
		};
		const signed = await issueGatewayBrowserToken({ ...base, hostDelegation });
		expect(
			(
				await verifyGatewayBrowserToken(signed, {
					secret: base.secret,
					expectedTediId: "worker",
					expectedTenantId: "tenant",
				})
			).hostDelegation,
		).toEqual(hostDelegation);
		await expect(
			issueGatewayBrowserToken({
				...base,
				hostDelegation: { ...hostDelegation, expiresAt: now - 1 },
			}),
		).rejects.toThrow();
		await expect(
			issueGatewayBrowserToken({
				...base,
				hostDelegation: {
					...hostDelegation,
					audience: "https://api.example.com/unrelated",
				},
			}),
		).rejects.toThrow();
		await expect(
			issueGatewayBrowserToken({
				...base,
				expiresAt: now + 120,
				hostDelegation,
			}),
		).rejects.toThrow();
	});
});

describe("embedded session surface", () => {
	const base = {
		allowedOrigin: "https://acme.os.tedix.dev",
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		secret: "surface-secret",
		sessionKey: "embed:surface",
		subject: "host:operator",
		tediId: "55555555-5555-4555-8555-555555555555",
	};

	it("round-trips the declared surface", async () => {
		const token = await issueGatewayBrowserToken({ ...base, surface: "os" });
		const claims = await verifyGatewayBrowserToken(token, {
			expectedTediId: base.tediId,
			secret: base.secret,
		});
		expect(claims.surface).toBe("os");
	});

	it("reads an absent or unknown surface as host", async () => {
		// Tokens minted before this claim existed, and anything unrecognised,
		// take the conservative default rather than the first-party behaviour.
		const token = await issueGatewayBrowserToken(base);
		const claims = await verifyGatewayBrowserToken(token, {
			expectedTediId: base.tediId,
			secret: base.secret,
		});
		expect(claims.surface).toBeUndefined();

		const forged = await issueGatewayBrowserToken({
			...base,
			surface: "admin" as never,
		});
		const forgedClaims = await verifyGatewayBrowserToken(forged, {
			expectedTediId: base.tediId,
			secret: base.secret,
		});
		expect(forgedClaims.surface).toBeUndefined();
	});
});
