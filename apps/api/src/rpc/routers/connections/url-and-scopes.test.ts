import { describe, expect, it } from "vite-plus/test";
import {
	COMMON_IDENTITY_SCOPES,
	chooseEffectiveConsentScopes,
	comparableUrl,
	getUrlParam,
	inferOAuthRegistrationMode,
	inferOutboundConnectionType,
	isPrivateOrLoopbackUrl,
	logoKind,
	mapConnectionRecord,
	normalizeRequestedScopes,
	parseScopesField,
	renderableLogoUrl,
	slugFromName,
	urlParamsArray,
	urlsEquivalent,
} from "./url-and-scopes";
import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";

describe("isPrivateOrLoopbackUrl", () => {
	// Every form below must be refused before a provider audit, discovery or
	// DCR fetch is attempted. The guard runs on the literal as written (before
	// DNS), so the numeric spellings the socket layer would accept count too.
	it.each([
		"http://127.0.0.1/",
		"http://127.1/",
		"http://2130706433/",
		"http://0x7f.0.0.1/",
		"http://0177.0.0.1/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:7f00:1]/",
		"http://0.0.0.0/",
		"http://169.254.169.254/latest/meta-data",
		"http://[fe80::1]/",
		"http://[fd00::1]/",
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://192.168.1.1/",
		"http://100.64.0.1/",
		"http://224.0.0.1/",
		"http://198.18.0.1/",
		"http://192.0.2.1/",
	])("blocks private, loopback, link-local and reserved IP %s", (url) => {
		expect(isPrivateOrLoopbackUrl(url)).toBe(true);
	});

	it.each([
		"http://localhost/x",
		"http://LOCALHOST/",
		"http://foo.localhost/",
		"http://foo.local/",
		"http://metadata.google.internal/",
	])("blocks local-resolution hostname %s", (url) => {
		expect(isPrivateOrLoopbackUrl(url)).toBe(true);
	});

	it.each(["ftp://example.com/", "file:///etc/passwd", "not a url", ""])(
		"blocks unparseable or non-http(s) URL %j",
		(url) => {
			expect(isPrivateOrLoopbackUrl(url)).toBe(true);
		},
	);

	it.each([
		"https://example.com/mcp",
		"http://example.com/mcp",
		"https://8.8.8.8/",
		"http://[2001:db8::1]/",
		"http://172.32.0.1/",
	])("allows public URL %s", (url) => {
		expect(isPrivateOrLoopbackUrl(url)).toBe(false);
	});

	it("keeps Tedix-served MCP endpoints reachable", () => {
		expect(isPrivateOrLoopbackUrl("https://acme.mcp.tedix.dev/mcp")).toBe(
			false,
		);
		expect(isPrivateOrLoopbackUrl("https://api.tedix.dev/")).toBe(false);
	});

	it("blocks the trailing-dot FQDN form http://localhost./x", () => {
		expect(isPrivateOrLoopbackUrl("http://localhost./x")).toBe(true);
	});
});

describe("scope parsing", () => {
	it("returns an empty list for missing scopes", () => {
		expect(parseScopesField(null)).toEqual([]);
		expect(parseScopesField(undefined)).toEqual([]);
		expect(parseScopesField("")).toEqual([]);
	});

	it("passes arrays through untouched", () => {
		expect(parseScopesField(["a", " b "])).toEqual(["a", " b "]);
	});

	it("parses a JSON array and drops non-string members", () => {
		expect(parseScopesField('["read", 1, null, "write"]')).toEqual([
			"read",
			"write",
		]);
	});

	it("falls back to the legacy comma/whitespace format", () => {
		expect(parseScopesField("read, write\n  admin")).toEqual([
			"read",
			"write",
			"admin",
		]);
		expect(parseScopesField('{"not":"an array"}')).toEqual([
			'{"not":"an',
			'array"}',
		]);
	});

	it("normalizes requested scopes to a trimmed, de-duplicated list", () => {
		expect(normalizeRequestedScopes(" read read write ")).toEqual([
			"read",
			"write",
		]);
		expect(normalizeRequestedScopes(["read", "read", " write "])).toEqual([
			"read",
			"write",
		]);
	});

	it("reports no requested scopes as undefined so fallbacks apply", () => {
		expect(normalizeRequestedScopes(undefined)).toBeUndefined();
		expect(normalizeRequestedScopes(null)).toBeUndefined();
		expect(normalizeRequestedScopes([])).toBeUndefined();
		expect(normalizeRequestedScopes("")).toBeUndefined();
		expect(normalizeRequestedScopes("  ,  ")).toBeUndefined();
	});

	it("chooses consent scopes in request, connection, profile, provider order", () => {
		const provider = {
			credentialProfile: { defaultScopes: ["profile.scope"] },
			requiredScopes: ["provider.scope"],
		} as unknown as Parameters<
			typeof chooseEffectiveConsentScopes
		>[0]["provider"];
		expect(
			chooseEffectiveConsentScopes({
				requestedScopes: "requested",
				connectionScopes: ["connection"],
				credentialProfile: { defaultScopes: ["credential"] },
				provider,
			}),
		).toEqual(["requested"]);
		expect(
			chooseEffectiveConsentScopes({
				connectionScopes: ["connection"],
				credentialProfile: { defaultScopes: ["credential"] },
				provider,
			}),
		).toEqual(["connection"]);
		expect(
			chooseEffectiveConsentScopes({
				credentialProfile: { defaultScopes: ["credential"] },
				provider,
			}),
		).toEqual(["credential"]);
		expect(chooseEffectiveConsentScopes({ provider })).toEqual([
			"profile.scope",
		]);
		expect(
			chooseEffectiveConsentScopes({
				provider: {
					requiredScopes: ["provider.scope"],
				} as unknown as typeof provider,
			}),
		).toEqual(["provider.scope"]);
		expect(chooseEffectiveConsentScopes({})).toBeUndefined();
	});

	it("maps stored scope fields onto connection records", () => {
		expect(
			mapConnectionRecord({
				appId: "github",
				providerName: "GitHub",
				status: "connected",
				connectedAt: 1,
				tokenExpiresAt: null,
				scopes: '["repo"]',
			}),
		).toEqual({
			appId: "github",
			providerName: "GitHub",
			status: "connected",
			connectedAt: 1,
			tokenExpiresAt: null,
			scopes: ["repo"],
			tokenScope: "tenant",
			connectedByUserId: null,
			connectedByEmail: null,
		});
	});

	it("treats common identity scopes as always advertised", () => {
		expect(COMMON_IDENTITY_SCOPES.has("openid")).toBe(true);
		expect(COMMON_IDENTITY_SCOPES.has("offline_access")).toBe(true);
		expect(COMMON_IDENTITY_SCOPES.has("repo")).toBe(false);
	});
});

describe("URL equivalence", () => {
	it("ignores trailing slashes and a bare root path", () => {
		expect(comparableUrl("https://example.com/")).toBe("https://example.com");
		expect(comparableUrl("https://example.com/mcp/")).toBe(
			"https://example.com/mcp",
		);
		expect(
			urlsEquivalent("https://example.com/mcp/", "https://example.com/mcp"),
		).toBe(true);
		expect(urlsEquivalent("https://example.com", "https://example.com/")).toBe(
			true,
		);
	});

	it("keeps query and fragment significant", () => {
		expect(
			urlsEquivalent("https://example.com/a?x=1", "https://example.com/a?x=2"),
		).toBe(false);
		expect(
			urlsEquivalent("https://example.com/a#one", "https://example.com/a#two"),
		).toBe(false);
	});

	it("distinguishes origins, schemes and ports", () => {
		expect(
			urlsEquivalent("https://a.example.com/", "https://b.example.com/"),
		).toBe(false);
		expect(urlsEquivalent("http://example.com/", "https://example.com/")).toBe(
			false,
		);
		expect(
			urlsEquivalent("https://example.com:8443/", "https://example.com/"),
		).toBe(false);
	});

	it("compares unparseable values after stripping trailing slashes", () => {
		expect(comparableUrl("not a url/")).toBe("not a url");
		expect(urlsEquivalent("not a url/", "not a url")).toBe(true);
		expect(comparableUrl(null)).toBeNull();
		expect(urlsEquivalent(null, null)).toBe(true);
		expect(urlsEquivalent(null, "https://example.com")).toBe(false);
	});
});

describe("provider value helpers", () => {
	it("slugs provider names and falls back to a stable default", () => {
		expect(slugFromName("  Acme MCP (beta) ")).toBe("acme-mcp-beta");
		expect(slugFromName("!!!")).toBe("mcp-provider");
	});

	it("renders only http(s) and base64 image data URLs as logos", () => {
		expect(renderableLogoUrl(" https://cdn.example.com/logo.png ")).toBe(
			"https://cdn.example.com/logo.png",
		);
		expect(renderableLogoUrl("data:image/svg+xml;base64,AAAA")).toBe(
			"data:image/svg+xml;base64,AAAA",
		);
		expect(renderableLogoUrl("javascript:alert(1)")).toBeNull();
		expect(renderableLogoUrl("data:text/html;base64,AAAA")).toBeNull();
		expect(renderableLogoUrl("")).toBeNull();
		expect(renderableLogoUrl(42)).toBeNull();
		expect(logoKind("https://cdn.example.com/logo.png")).toBe("url");
		expect(logoKind("data:image/png;base64,AAAA")).toBe("data");
		expect(logoKind("   ")).toBe("missing");
		expect(logoKind("ftp://x")).toBe("invalid");
	});

	it("reads url params defensively", () => {
		const params = urlParamsArray([
			{ key: "resource", value: "https://example.com" },
			{ key: 1, value: "ignored" },
			"junk",
			null,
		]);
		expect(params).toEqual([{ key: "resource", value: "https://example.com" }]);
		expect(getUrlParam(params, "resource")).toBe("https://example.com");
		expect(getUrlParam(params, "missing")).toBeNull();
		expect(urlParamsArray("nope")).toEqual([]);
	});

	it("infers the connection type and OAuth registration mode", () => {
		expect(inferOutboundConnectionType({ appType: "apikey" })).toBe("api_key");
		expect(inferOutboundConnectionType({ useDcr: true })).toBe("oauth");
		expect(inferOutboundConnectionType({ clientId: "abc" })).toBe("oauth");
		expect(inferOAuthRegistrationMode({ appType: "apikey" })).toBeNull();
		expect(
			inferOAuthRegistrationMode({
				clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
			}),
		).toBe("cimd");
		expect(inferOAuthRegistrationMode({ useDcr: true })).toBe("dcr");
		expect(inferOAuthRegistrationMode({ clientId: "static" })).toBe(
			"pre_registered",
		);
		expect(inferOAuthRegistrationMode({ appType: "oauth" })).toBe("invalid");
	});
});
