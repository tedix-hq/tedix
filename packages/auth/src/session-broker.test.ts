import { describe, expect, it } from "vite-plus/test";

import {
	assertExchangeSessionBrokerCodeInput,
	assertSessionBrokerAuthorizationCode,
	assertSessionBrokerIntent,
	assertSessionBrokerRedirectPath,
	assertSessionBrokerTargetOrigin,
	buildSessionBrokerAuthorizeUrl,
	buildSessionBrokerCallbackUrl,
	buildSessionBrokerLoginUrl,
	isSessionBrokerTenantId,
	readSessionBrokerOrigins,
	SESSION_BROKER_INTENT_TTL_SECONDS,
	type SessionBrokerContractError,
	type SessionBrokerIntent,
} from "./session-broker";

const NOW = 1_800_000_000;
const INTENT_ID = "request_1234567890abcdefghij";
const CODE = "code_1234567890abcdefghijkl";
const STATE_HASH = `sha256-${"a".repeat(43)}`;

function intent(
	overrides: Partial<SessionBrokerIntent> = {},
): SessionBrokerIntent {
	return {
		callbackPath: "/auth/session-broker/callback",
		expiresAt: NOW + 60,
		intentId: INTENT_ID,
		issuedAt: NOW,
		operation: "issue_session",
		redirectPath: "/workspace/workspace-1",
		stateHash: STATE_HASH,
		surface: "os",
		targetOrigin: "https://tedix.os.tedix.dev",
		tenantId: "org_tedix",
		version: 1,
		...overrides,
	};
}

function expectCode(
	fn: () => unknown,
	code: SessionBrokerContractError["code"],
) {
	expect(fn).toThrow(expect.objectContaining({ code }));
}

describe("session broker contract", () => {
	it("binds named OAuth intents to their initiating user and opaque account selector", () => {
		const named = intent({
			operation: "outbound_connect",
			outboundAppId: "microsoft",
			tenantId: null,
			outboundUserId: "alice",
			outboundExternalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
			outboundScopes: ["Mail.Read"],
		});
		expect(() => assertSessionBrokerIntent(named, NOW)).not.toThrow();
		expect(() =>
			assertSessionBrokerIntent({ ...named, tenantId: "org_tedix" }, NOW),
		).not.toThrow();
		for (const invalid of [
			{ ...named, tenantId: "invalid tenant" },
			{ ...named, outboundUserId: undefined },
			{ ...named, outboundExternalIdentifier: "Personal" },
			{ ...named, operation: "issue_session" },
			{ ...named, outboundScopes: [123] },
		]) {
			expect(() =>
				assertSessionBrokerIntent(
					invalid as unknown as SessionBrokerIntent,
					NOW,
				),
			).toThrow();
		}
	});
	it("binds an independent installation to two exact hosts and one Descope auth host", () => {
		const osOrigin = "https://os.acme.example";
		const brokerOrigin = "https://auth.acme.example";
		expect(
			readSessionBrokerOrigins({
				OS_URL: osOrigin,
				SESSION_BROKER_URL: brokerOrigin,
				DESCOPE_BASE_URL: brokerOrigin,
			}),
		).toEqual({ osOrigin, brokerOrigin });
		expect(assertSessionBrokerTargetOrigin("os", osOrigin, osOrigin)).toBe(
			osOrigin,
		);
		expect(assertSessionBrokerTargetOrigin("cli", osOrigin, osOrigin)).toBe(
			osOrigin,
		);
		for (const [surface, target] of [
			["os", "https://os.acme.example.evil.test"],
			["os", "https://tenant.os.acme.example"],
			["os", "https://os.tedix.dev"],
			["docs", osOrigin],
		] as const) {
			expectCode(
				() => assertSessionBrokerTargetOrigin(surface, target, osOrigin),
				"INVALID_TARGET_ORIGIN",
			);
		}
		expect(buildSessionBrokerAuthorizeUrl(INTENT_ID, brokerOrigin)).toBe(
			`${brokerOrigin}/tedix/session/authorize?intent=${INTENT_ID}`,
		);
		expect(buildSessionBrokerLoginUrl(INTENT_ID, { osOrigin })).toBe(
			`${osOrigin}/login?intent=${INTENT_ID}`,
		);
		expect(
			buildSessionBrokerCallbackUrl(
				intent({ targetOrigin: osOrigin }),
				CODE,
				NOW,
				osOrigin,
			),
		).toContain(`${osOrigin}/auth/session-broker/callback?`);
	});

	it("rejects partial, malformed, and cookie-split installation origins", () => {
		const valid = {
			OS_URL: "https://os.acme.example",
			SESSION_BROKER_URL: "https://auth.acme.example",
			DESCOPE_BASE_URL: "https://auth.acme.example",
		};
		for (const vars of [
			{ ...valid, OS_URL: undefined },
			{ ...valid, OS_URL: "https://os.acme.example/path" },
			{ ...valid, SESSION_BROKER_URL: "https://auth.acme.example:443" },
			{ ...valid, DESCOPE_BASE_URL: "https://api.descope.com" },
			{ ...valid, OS_URL: "https://os.tedix.dev" },
			{ DESCOPE_BASE_URL: "https://auth.acme.example" },
		]) {
			expectCode(() => readSessionBrokerOrigins(vars), "INVALID_TARGET_ORIGIN");
		}
	});
	it("owns the tenant-id grammar used by product entry surfaces", () => {
		expect(isSessionBrokerTenantId("org_tedix")).toBe(true);
		expect(isSessionBrokerTenantId("Tenant.eu:1")).toBe(true);
		expect(
			isSessionBrokerTenantId("org_tedix&redirect_to=https://evil.example"),
		).toBe(false);
	});

	it("accepts exact production origins for each browser surface", () => {
		expect(
			assertSessionBrokerTargetOrigin(
				"docs",
				"https://acme-help.docs.tedix.dev",
			),
		).toBe("https://acme-help.docs.tedix.dev");
		expect(assertSessionBrokerTargetOrigin("cli", "https://os.tedix.dev")).toBe(
			"https://os.tedix.dev",
		);
		expect(
			assertSessionBrokerTargetOrigin("cli", "https://os.tedix.tech"),
		).toBe("https://os.tedix.tech");
		expect(
			assertSessionBrokerTargetOrigin("os", "https://acme.os.tedix.dev"),
		).toBe("https://acme.os.tedix.dev");
		expect(assertSessionBrokerTargetOrigin("os", "https://os.tedix.tech")).toBe(
			"https://os.tedix.tech",
		);
		expect(
			assertSessionBrokerTargetOrigin("os", "https://acme.os.tedix.tech"),
		).toBe("https://acme.os.tedix.tech");
		expect(
			assertSessionBrokerTargetOrigin("cms", "https://tedix.cms.tedix.dev"),
		).toBe("https://tedix.cms.tedix.dev");
	});

	it.each([
		["os", "https://app.tedix.dev"],
		["docs", "https://nested.tenant.docs.tedix.dev"],
		["os", "https://nested.tenant.os.tedix.dev"],
		["os", "https://nested.tenant.os.tedix.tech"],
		["os", "https://evil-os.tedix.tech"],
		["os", "https://tenant.os.tedix.dev:443"],
		["os", "https://user@tenant.os.tedix.dev"],
		["os", "https://tenant.os.tedix.dev/path"],
		["os", "http://tenant.os.tedix.dev"],
		["cms", "https://customer.example"],
		["cli", "http://127.0.0.1:8321"],
	] as const)("rejects %s target %s", (surface, origin) => {
		expectCode(
			() => assertSessionBrokerTargetOrigin(surface, origin),
			"INVALID_TARGET_ORIGIN",
		);
	});

	it.each([
		"https://evil.example/steal",
		"//evil.example/steal",
		"/\\evil.example/steal",
		"/workspace/workspace-1#secret",
		"canvas",
	] as const)("rejects unsafe redirect %s", (redirect) => {
		expectCode(
			() =>
				assertSessionBrokerRedirectPath(redirect, "https://tedix.os.tedix.dev"),
			"INVALID_REDIRECT_PATH",
		);
	});

	it("binds intent version, TTL, state, tenant, origin, and callback", () => {
		expect(assertSessionBrokerIntent(intent(), NOW)).toEqual(intent());
		expectCode(
			() =>
				assertSessionBrokerIntent(
					intent({ expiresAt: NOW + SESSION_BROKER_INTENT_TTL_SECONDS + 1 }),
					NOW,
				),
			"INVALID_EXPIRY",
		);
		expectCode(
			() =>
				assertSessionBrokerIntent(
					intent({ callbackPath: "/attacker/callback" }),
					NOW,
				),
			"INVALID_CALLBACK_PATH",
		);
		expectCode(
			() => assertSessionBrokerIntent(intent({ stateHash: "raw-state" }), NOW),
			"INVALID_STATE_HASH",
		);
	});

	it("builds a central login URL from only an opaque intent", () => {
		expect(buildSessionBrokerLoginUrl(INTENT_ID)).toBe(
			`https://os.tedix.dev/login?intent=${INTENT_ID}`,
		);
		expect(
			buildSessionBrokerLoginUrl(INTENT_ID, {
				skipOrganizationPreparation: true,
			}),
		).toBe(`https://os.tedix.dev/login?intent=${INTENT_ID}&outbound=1`);
		expectCode(
			() => buildSessionBrokerLoginUrl("https://evil.example"),
			"INVALID_INTENT_ID",
		);
	});

	it("keeps tenant authority out of resume and logout intents", () => {
		for (const operation of ["resume_session", "logout"] as const) {
			expect(
				assertSessionBrokerIntent(intent({ operation, tenantId: null }), NOW),
			).toMatchObject({ operation, tenantId: null });
			expectCode(
				() => assertSessionBrokerIntent(intent({ operation }), NOW),
				"INVALID_TENANT_ID",
			);
		}
	});

	it.each([
		["docs", "https://docs.tedix.dev", "/auth/session-broker/callback"],
		["cli", "https://os.tedix.dev", "/cli/session-broker/callback"],
		[
			"cms",
			"https://tedix.cms.tedix.dev",
			"/_emdash/api/auth/session-broker/callback",
		],
	] as const)(
		"accepts the fixed %s callback",
		(surface, targetOrigin, callbackPath) => {
			expect(
				assertSessionBrokerIntent(
					intent({ callbackPath, surface, targetOrigin }),
					NOW,
				),
			).toMatchObject({ callbackPath, surface, targetOrigin });
		},
	);

	it("enforces the separate 30-second authorization-code lifetime", () => {
		expect(
			assertSessionBrokerAuthorizationCode(
				{
					code: CODE,
					expiresAt: NOW + 30,
					intentId: INTENT_ID,
					issuedAt: NOW,
				},
				NOW,
			),
		).toMatchObject({ code: CODE });
		expectCode(
			() =>
				assertSessionBrokerAuthorizationCode(
					{
						code: CODE,
						expiresAt: NOW + 31,
						intentId: INTENT_ID,
						issuedAt: NOW,
					},
					NOW,
				),
			"INVALID_CODE_EXPIRY",
		);
	});

	it("builds navigation URLs containing only opaque one-time references", () => {
		const authorize = new URL(buildSessionBrokerAuthorizeUrl(INTENT_ID));
		expect(authorize.origin).toBe("https://auth.tedix.dev");
		expect(authorize.pathname).toBe("/tedix/session/authorize");
		expect([...authorize.searchParams.keys()]).toEqual(["intent"]);

		const callback = new URL(
			buildSessionBrokerCallbackUrl(intent(), CODE, NOW),
		);
		expect(callback.origin).toBe("https://tedix.os.tedix.dev");
		expect(callback.pathname).toBe("/auth/session-broker/callback");
		expect(Object.fromEntries(callback.searchParams)).toEqual({
			code: CODE,
			intent: INTENT_ID,
		});
		for (const url of [authorize, callback]) {
			expect(url.href).not.toMatch(/DSR|refresh|sessionJwt|authorization/i);
		}
	});

	it("requires the server-side exchange to repeat every security binding", () => {
		expect(
			assertExchangeSessionBrokerCodeInput(
				{
					code: CODE,
					intentId: INTENT_ID,
					stateHash: STATE_HASH,
					targetOrigin: "https://docs.tedix.dev",
					tenantId: "org_tedix",
				},
				"docs",
			),
		).toMatchObject({ tenantId: "org_tedix" });
		expectCode(
			() =>
				assertExchangeSessionBrokerCodeInput(
					{
						code: CODE,
						intentId: INTENT_ID,
						stateHash: STATE_HASH,
						targetOrigin: "https://tedix.os.tedix.dev",
						tenantId: "org_tedix",
					},
					"docs",
				),
			"INVALID_TARGET_ORIGIN",
		);
	});

	it("allows tenantless exchange only when the stored intent is tenantless", () => {
		expect(
			assertExchangeSessionBrokerCodeInput(
				{
					code: CODE,
					intentId: INTENT_ID,
					stateHash: STATE_HASH,
					targetOrigin: "https://docs.tedix.dev",
					tenantId: null,
				},
				"docs",
			),
		).toMatchObject({ tenantId: null });
	});
});
