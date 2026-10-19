import { MCP_GRANULAR_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	collectDescopeResourceScopes,
	toDescopeConnectionScopes,
} from "@tedix/api-contract/utils/mcp-scope-catalog";
import {
	isReadOnlyConsentSelection,
	selectConsentPreset,
} from "@tedix/mcp-shared/auth/consent-scopes";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	consentForm,
	firstConsentOrganizationIds,
	selectedConsentPermissions,
	advanceInboundConsentFlow,
	INBOUND_CONSENT_AUTHORIZE_INTERACTION,
	INBOUND_CONSENT_CANCEL_INTERACTION,
	INBOUND_CONSENT_SCREEN_NAMES,
	INBOUND_CONSENT_FLOW_ID,
	inboundConsentCallbackUrl,
	inboundConsentResourceUrl,
	inboundConsentDecisionError,
	inboundConsentClientReference,
	inboundConsentContextError,
	inboundConsentFlowFailure,
	inboundConsentFlowError,
	inboundConsentPreFlowBrokerPath,
	inboundConsentRecoveryUrl,
	inboundConsentResumableAfterBroker,
	inboundConsentRequestedPermissions,
	inboundConsentTenant,
	isInvalidDescopeJwtFamily,
	isExpiredDescopeOauthCallback,
} from "./inbound-consent-page";
import { normalizeConsentPermissions } from "@/shared/consent-permissions";

describe("inbound consent BYOS contract", () => {
	it("pins the live Descope screen and interaction identifiers", () => {
		expect([...INBOUND_CONSENT_SCREEN_NAMES]).toEqual([
			"Consent Screen - Verified App",
			"Consent Screen - Unverified App",
			"Consent Screen - Verified",
			"Consent Screen - Unverified",
		]);
		expect(INBOUND_CONSENT_AUTHORIZE_INTERACTION).toBe("_Z6xPaS9jy");
		expect(INBOUND_CONSENT_CANCEL_INTERACTION).toBe("6N3cb_5t3T");
		expect(INBOUND_CONSENT_FLOW_ID).toBe("inbound-apps-multi-org-consent");
	});

	it("passes the broker-selected tenant into the Descope consent flow", () => {
		expect(
			inboundConsentTenant(
				"https://os.tedix.dev/oauth/consent?tenant=org_tedix",
			),
		).toBe("org_tedix");
		expect(inboundConsentTenant("https://os.tedix.dev/oauth/consent")).toBe(
			undefined,
		);
	});

	it("separates the reusable callback from one-time provider parameters", () => {
		const location =
			"https://os.tedix.dev/oauth/consent?tenant=org_tedix&code=spent&descope-login-flow=inbound-apps-user-consent%7C%23%7Cexecution.end&third_party_app_state_id=s-123&application_scopes=mcp%3Aapps.read";
		expect(inboundConsentCallbackUrl(location)).toBe(
			"https://os.tedix.dev/oauth/consent?tenant=org_tedix",
		);
		// The legacy `mode` parameter is not carried into the callback.
		expect(
			inboundConsentCallbackUrl(
				"https://os.tedix.dev/oauth/consent?mode=multi-org&third_party_app_id=TPAclient1&code=spent",
			),
		).toBe("https://os.tedix.dev/oauth/consent?third_party_app_id=TPAclient1");
		expect(
			inboundConsentClientReference(
				null,
				"https://os.tedix.dev/oauth/consent?mode=multi-org&third_party_app_id=TPAclient1",
			),
		).toBe("TPAclient1");
		expect(
			inboundConsentClientReference(
				null,
				"https://os.tedix.dev/oauth/consent?mode=multi-org&third_party_app_id=unknown",
			),
		).toBeNull();
	});

	it("preserves only a trusted immutable authorize URL across IdP redirects", () => {
		const initialLocation =
			"https://os.tedix.dev/oauth/consent?tenant=org_tedix&third_party_app_state_id=s-123";
		const callbackLocation = `${initialLocation}&code=one-time&descope-login-flow=inbound-apps-user-consent%7C%23%7Cexecution.end`;
		const authorize =
			"https://api.descope.com/oauth2/v1/apps/project/authorize?state=opaque";
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		expect(inboundConsentRecoveryUrl(initialLocation, authorize, storage)).toBe(
			authorize,
		);
		expect(
			inboundConsentRecoveryUrl(
				callbackLocation,
				"https://accounts.google.com/",
				storage,
			),
		).toBe(authorize);
		expect(
			inboundConsentRecoveryUrl(
				callbackLocation,
				"https://attacker.example/authorize?state=stolen",
				{ getItem: () => null, setItem: vi.fn() },
			),
		).toBeNull();
	});

	it("groups granular scopes while preserving their exact names", () => {
		const scopes = normalizeConsentPermissions([
			{ name: "mcp:skills.write", description: "Run skills" },
			{ name: "mcp:skills.read", description: "Read skills" },
			{ name: "mcp:settings.admin", description: "Admin settings" },
			{ name: "mcp:skills.read", description: "duplicate" },
			"connections.execute",
		]);
		expect(scopes.map((scope) => scope.name).sort()).toEqual([
			"connections.execute",
			"mcp:settings.admin",
			"mcp:skills.read",
			"mcp:skills.write",
		]);
		expect(
			scopes.find((scope) => scope.name === "mcp:settings.admin"),
		).toMatchObject({
			group: "Settings",
			authority: "admin",
			admin: true,
		});
		expect(
			scopes.find((scope) => scope.name === "mcp:skills.read"),
		).toMatchObject({
			group: "Skills",
			authority: "read",
			admin: false,
		});
	});

	it("recognizes Descope refresh-family invalidation in flow errors", () => {
		const error = {
			errorCode: "E064006",
			errorDescription: "JWT family ID invalidated, cannot use this token",
		};
		expect(
			isInvalidDescopeJwtFamily(inboundConsentFlowError({ ok: false, error })),
		).toBe(true);
		expect(inboundConsentFlowError({ ok: true, data: {} })).toBeNull();
		expect(isInvalidDescopeJwtFamily(new Error("network unavailable"))).toBe(
			false,
		);
	});

	it("classifies a spent provider callback separately from session expiry", () => {
		const error = {
			errorCode: "E061301",
			errorDescription: "Failed to exchange OAuth code",
		};
		expect(isExpiredDescopeOauthCallback(error)).toBe(true);
		expect(inboundConsentFlowFailure(error)).toBe("expired-callback");
		expect(inboundConsentFlowFailure(new Error("network unavailable"))).toBe(
			"unknown",
		);
	});

	it("reads the documented BYOS context error after next", () => {
		const error = {
			code: "E064006",
			description: "JWT family ID invalidated, cannot use this token",
		};
		expect(inboundConsentContextError({ error })).toBe(error);
		expect(isInvalidDescopeJwtFamily(error)).toBe(true);
		expect(inboundConsentContextError({ data: {} })).toBeNull();
	});

	it("leaves a fulfilled BYOS advance to Descope-owned navigation", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true, data: {} });
		await expect(
			advanceInboundConsentFlow(next, "authorize", { approved: true }),
		).resolves.toBeNull();
		expect(next).toHaveBeenCalledWith("authorize", { approved: true });
	});

	it("surfaces BYOS response and rejection errors without a URL timer", async () => {
		const responseError = new Error("flow response failed");
		await expect(
			advanceInboundConsentFlow(
				vi.fn().mockResolvedValue({ ok: false, error: responseError }),
				"authorize",
				{},
			),
		).resolves.toBe(responseError);

		const rejection = new Error("flow request rejected");
		await expect(
			advanceInboundConsentFlow(
				vi.fn().mockRejectedValue(rejection),
				"authorize",
				{},
			),
		).resolves.toBe(rejection);
	});
});

it("submits the exact scopes in the current authorization request", () => {
	const permissions = normalizeConsentPermissions([
		{ name: "mcp:apps.read", optional: true },
		{ name: "mcp:apps.admin", optional: true },
		{ name: "openid", optional: false },
	]);
	expect(
		consentForm(
			{
				form: {
					other: "preserved",
					thirdPartyAppApproveScopes: ["mcp:apps.admin"],
				},
			},
			permissions,
		),
	).toEqual({
		other: "preserved",
		thirdPartyAppApproveScopes: ["mcp:apps.admin", "mcp:apps.read", "openid"],
	});
});

it("submits only chosen scopes and organization IDs for Tedix Connect", () => {
	const permissions = normalizeConsentPermissions(["mcp:apps.read"]);
	expect(
		consentForm(
			{
				form: {
					thirdPartyAppApproveScopes: ["mcp:apps.admin"],
					email: "previous-screen@example.test",
				},
			},
			permissions,
			["org_tedix", "org_sample"],
		),
	).toEqual({
		thirdPartyAppApproveScopes: ["mcp:apps.read"],
		"form.tedixSelectedOrganizations": '["org_tedix","org_sample"]',
	});
});

it("retains the exact resource and application across single-org callbacks, rejecting unsafe resource URLs", () => {
	const authorize =
		"https://auth.tedix.dev/oauth2/v1/apps/authorize?resource=https%3A%2F%2Ftedix-unified.mcp.tedix.dev%2Fmcp";
	const callback = new URL(
		inboundConsentCallbackUrl(
			"https://os.tedix.dev/oauth/consent?tenant=org_tedix&third_party_app_id=TPAclient&code=spent",
			authorize,
		),
	);
	expect(callback.searchParams.get("resource")).toBe(
		"https://tedix-unified.mcp.tedix.dev/mcp",
	);
	expect(callback.searchParams.get("third_party_app_id")).toBe("TPAclient");
	expect(callback.searchParams.has("code")).toBe(false);
	for (const resource of [
		"http://unsafe.example/mcp",
		"https://user:secret@example.com/mcp",
		"https://example.com/mcp?token=secret",
		"https://example.com/mcp#fragment",
	]) {
		expect(
			inboundConsentResourceUrl(
				`https://os.tedix.dev/oauth/consent?resource=${encodeURIComponent(resource)}`,
			),
		).toBeNull();
	}
});

it("accepts the real Descope oidc_resource redirect and preserves it after SDK callback cleanup", () => {
	const resource = "https://tedix-unified.mcp.tedix.dev/mcp";
	const initial = `https://os.tedix.dev/oauth/consent?tenant=org_tedix&third_party_app_id=TPAclient&oidc_resource=${encodeURIComponent(resource)}&code=one-use`;
	expect(inboundConsentResourceUrl(initial)).toBe(resource);
	const callback = inboundConsentCallbackUrl(initial);
	expect(new URL(callback).searchParams.get("resource")).toBe(resource);
	expect(new URL(callback).searchParams.has("oidc_resource")).toBe(false);
	expect(new URL(callback).searchParams.has("code")).toBe(false);
	expect(inboundConsentResourceUrl(callback)).toBe(resource);
	expect(
		inboundConsentResourceUrl(
			initial,
			`https://auth.tedix.dev/oauth2/v1/apps/authorize?resource=${encodeURIComponent(resource)}`,
		),
	).toBe(resource);
});
it("rejects conflicting resource aliases, repeated fields and immutable authorize bindings", () => {
	const resource = "https://tedix-unified.mcp.tedix.dev/mcp";
	const other = "https://connect.mcp.tedix.dev/mcp";
	const base = `https://os.tedix.dev/oauth/consent?resource=${encodeURIComponent(resource)}`;
	expect(
		inboundConsentResourceUrl(
			`${base}&oidc_resource=${encodeURIComponent(other)}`,
		),
	).toBeNull();
	expect(
		inboundConsentResourceUrl(`${base}&resource=${encodeURIComponent(other)}`),
	).toBeNull();
	expect(
		inboundConsentResourceUrl(
			base,
			`https://auth.tedix.dev/oauth2/v1/apps/authorize?resource=${encodeURIComponent(other)}`,
		),
	).toBeNull();
});

it("distinguishes an expired consent session from policy rejection", () => {
	expect(inboundConsentDecisionError({ code: "UNAUTHORIZED" })).toContain(
		"session expired",
	);
	expect(inboundConsentDecisionError({ status: 401 })).toContain(
		"session expired",
	);
	expect(
		inboundConsentDecisionError({ code: "FORBIDDEN", status: 403 }),
	).toContain("OAuth client configuration");
	expect(inboundConsentDecisionError({ status: 403 })).toContain(
		"organization access",
	);
	expect(
		inboundConsentDecisionError({ code: "SERVICE_UNAVAILABLE", status: 503 }),
	).toBe("Could not save this consent decision. Please try again.");
});

it("requires separate platform opt-in and eligible project role even when ordinary selection includes it", () => {
	const offered = normalizeConsentPermissions([
		"mcp:apps.read",
		"platform:admin",
	]);
	for (const [eligible, optedIn] of [
		[false, false],
		[false, true],
		[true, false],
	]) {
		expect(
			selectedConsentPermissions(
				offered,
				["mcp:apps.read", "platform:admin"],
				eligible!,
				optedIn!,
			).map((scope) => scope.name),
		).toEqual(["mcp:apps.read"]);
	}
	expect(
		selectedConsentPermissions(offered, ["mcp:apps.read"], true, true).map(
			(scope) => scope.name,
		),
	).toEqual(["mcp:apps.read", "platform:admin"]);
});

it("bounds bulk organization selection without disabling accounts with more than ten", () => {
	const organizations = Array.from({ length: 12 }, (_, index) => ({
		id: `org_${index}`,
	}));
	expect(firstConsentOrganizationIds(organizations)).toEqual([
		"org_0",
		"org_1",
		"org_2",
		"org_3",
		"org_4",
		"org_5",
		"org_6",
		"org_7",
		"org_8",
		"org_9",
	]);
	expect(firstConsentOrganizationIds(organizations.slice(0, 2))).toEqual([
		"org_0",
		"org_1",
	]);
	expect(firstConsentOrganizationIds([])).toEqual([]);
	expect(organizations).toHaveLength(12);
});

describe("reloaded consent requests", () => {
	it("treats a consent screen with no requested permissions as a lost request", () => {
		expect(inboundConsentRequestedPermissions({})).toBeNull();
		expect(inboundConsentRequestedPermissions({ data: {} })).toBeNull();
		expect(
			inboundConsentRequestedPermissions({
				data: { inboundAppApproveScopes: [] },
			}),
		).toBeNull();
	});

	it("keeps every requested permission, including protocol scopes", () => {
		const scopes = inboundConsentRequestedPermissions({
			data: {
				inboundAppApproveScopes: [
					{ name: "openid" },
					{ name: "mcp:apps.read", description: "Read apps" },
				],
			},
		});
		expect(scopes?.map((scope) => scope.name).sort()).toEqual([
			"mcp:apps.read",
			"openid",
		]);
	});
});

describe("product-session bounce keeps the authorization transaction", () => {
	const authorizeLoad =
		"https://os.tedix.dev/oauth/consent?application_scopes=mcp%3Awork.read&oidc_resource=https%3A%2F%2Fconnect.mcp.tedix.dev%2Fmcp&third_party_app_id=TPAclient1&third_party_app_state_id=s-abc";
	// Descope returns from a provider login without the state id.
	const providerCallback =
		"https://os.tedix.dev/oauth/consent?code=one-time&descope-login-flow=inbound-apps-multi-org-consent%7C%23%7Cexecution.end&resource=https%3A%2F%2Fconnect.mcp.tedix.dev%2Fmcp&third_party_app_id=TPAclient1";

	it("signs in to Tedix OS before the flow starts, returning with the state id", () => {
		const path = inboundConsentPreFlowBrokerPath(authorizeLoad, false);
		expect(path).not.toBeNull();
		const start = new URL(path!, "https://os.tedix.dev");
		expect(start.pathname).toBe("/auth/session-broker/start");
		const returnTo = start.searchParams.get("redirect_to")!;
		expect(returnTo.startsWith("/oauth/consent?")).toBe(true);
		expect(inboundConsentResumableAfterBroker(returnTo)).toBe(true);
		expect(
			new URL(returnTo, "https://os.tedix.dev").searchParams.get(
				"third_party_app_state_id",
			),
		).toBe("s-abc");
		// A signed-in browser, a broker error, or a provider callback starts the flow.
		expect(inboundConsentPreFlowBrokerPath(authorizeLoad, true)).toBeNull();
		expect(
			inboundConsentPreFlowBrokerPath(`${authorizeLoad}&error=denied`, false),
		).toBeNull();
		expect(inboundConsentPreFlowBrokerPath(providerCallback, false)).toBeNull();
	});

	it("never bounces a provider callback, and still offers the original request for retry", () => {
		// The SDK has already stripped code and descope-login-flow by then.
		const strippedCallback =
			"/oauth/consent?resource=https%3A%2F%2Fconnect.mcp.tedix.dev%2Fmcp&third_party_app_id=TPAclient1";
		expect(inboundConsentResumableAfterBroker(strippedCallback)).toBe(false);

		const authorize =
			"https://auth.tedix.dev/oauth2/v1/apps/project/authorize?client_id=https%3A%2F%2Fos.tedix.dev%2F.well-known%2Foauth-client%2Ftedix-cli.json&state=opaque";
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		expect(inboundConsentRecoveryUrl(authorizeLoad, authorize, storage)).toBe(
			authorize,
		);
		expect(
			inboundConsentRecoveryUrl(
				providerCallback,
				"https://accounts.google.com/",
				storage,
			),
		).toBe(authorize);
		expect(
			inboundConsentRecoveryUrl(
				providerCallback.replace("TPAclient1", "TPAother"),
				"https://accounts.google.com/",
				storage,
			),
		).toBeNull();
	});
});

it("submits every read-only capability subset without adding declined authority", () => {
	const config = { scopeDescriptions: MCP_GRANULAR_CAPABILITY_SCOPES };
	const registered = toDescopeConnectionScopes(
		collectDescopeResourceScopes({ mcpConfig: config }),
		config,
	);
	const offered = normalizeConsentPermissions(registered);
	const read = selectConsentPreset(offered, "read").filter(
		(name) => name.startsWith("mcp:") || name.startsWith("connections."),
	);
	expect(read).toHaveLength(11);
	for (let mask = 0; mask < 2 ** read.length; mask++) {
		const selected = read.filter((_, index) => Boolean(mask & (1 << index)));
		const permissions = selectedConsentPermissions(
			offered,
			selected,
			false,
			false,
		);
		const form = consentForm(
			{},
			permissions,
			["fictional-viewer-tenant"],
			"fictional-revision",
		);
		expect(form.thirdPartyAppApproveScopes).toEqual(
			permissions.map((scope) => scope.name),
		);
		expect([...(form.thirdPartyAppApproveScopes as string[])].sort()).toEqual(
			[...selected].sort(),
		);
		expect(
			isReadOnlyConsentSelection(form.thirdPartyAppApproveScopes as string[]),
		).toBe(true);
		expect(permissions.every((permission) => !permission.required)).toBe(true);
	}
});
