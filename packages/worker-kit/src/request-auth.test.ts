import { describe, expect, it } from "vite-plus/test";
import {
	applyInboundTrustHeaderHygiene,
	applyOperatorConsentHeaderHygiene,
	extractBearerToken,
	extractWebSocketBearerToken,
	INTERNAL_TRUST_HEADERS,
	isServiceBinding,
	stripServiceBindingMarker,
	OPERATOR_CONSENT_HEADER,
	PLATFORM_CALLER_HEADER,
	PLATFORM_CALLER_TEDI_EDGE,
	pickEchoableSubprotocol,
	secureEqual,
} from "./request-auth";

describe("applyOperatorConsentHeaderHygiene", () => {
	it("strips both headers from public ingress", () => {
		const headers = new Headers({
			[OPERATOR_CONSENT_HEADER]: '{"v":1}',
			[PLATFORM_CALLER_HEADER]: PLATFORM_CALLER_TEDI_EDGE,
		});
		applyOperatorConsentHeaderHygiene(headers, false);
		expect(headers.has(OPERATOR_CONSENT_HEADER)).toBe(false);
		expect(headers.has(PLATFORM_CALLER_HEADER)).toBe(false);
	});

	it("never lets an inbound marker survive, even on internal hops", () => {
		const headers = new Headers({
			[PLATFORM_CALLER_HEADER]: PLATFORM_CALLER_TEDI_EDGE,
		});
		applyOperatorConsentHeaderHygiene(headers, true);
		expect(headers.has(PLATFORM_CALLER_HEADER)).toBe(false);
	});

	it("stamps the marker only for internal hops carrying a consent header", () => {
		const headers = new Headers({
			[OPERATOR_CONSENT_HEADER]: '{"v":1}',
			[PLATFORM_CALLER_HEADER]: "forged-by-caller",
		});
		applyOperatorConsentHeaderHygiene(headers, true);
		expect(headers.get(OPERATOR_CONSENT_HEADER)).toBe('{"v":1}');
		expect(headers.get(PLATFORM_CALLER_HEADER)).toBe(PLATFORM_CALLER_TEDI_EDGE);
	});

	it("leaves consent-free internal hops unmarked", () => {
		const headers = new Headers();
		applyOperatorConsentHeaderHygiene(headers, true);
		expect(headers.has(PLATFORM_CALLER_HEADER)).toBe(false);
	});
});

describe("applyInboundTrustHeaderHygiene", () => {
	it("strips every internal-trust marker from external ingress", () => {
		const headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Caller-Type": "mcp-edge-external-agent",
			"X-Tedix-Tedi-Id": "tedi-victim",
			"X-Tedix-Tedi-Scopes": "platform:admin",
			"X-Tedix-Acting-User": "U-attacker",
			"X-Tedix-Tenant-Id": "T-evil",
			"X-Tedix-Admin-Token": "forged",
			"X-Tedix-External-Agent-Principal-Id": "P-forged",
			"x-tedix-auth-type": "service",
			[OPERATOR_CONSENT_HEADER]: '{"v":1}',
			[PLATFORM_CALLER_HEADER]: PLATFORM_CALLER_TEDI_EDGE,
			// Legitimate client / transport headers must survive untouched.
			Authorization: "Bearer user-jwt",
			Cookie: "DS=session",
			"Content-Type": "application/json",
		});
		applyInboundTrustHeaderHygiene(headers, false);
		for (const name of INTERNAL_TRUST_HEADERS) {
			expect(headers.has(name)).toBe(false);
		}
		// Prefix-covered derived-auth + external-agent families are gone too.
		expect(headers.has("x-tedix-auth-type")).toBe(false);
		expect(headers.has("X-Tedix-External-Agent-Principal-Id")).toBe(false);
		// Client-legit headers are preserved.
		expect(headers.get("Authorization")).toBe("Bearer user-jwt");
		expect(headers.get("Cookie")).toBe("DS=session");
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	it("leaves internally-stamped markers intact on service-binding hops", () => {
		const headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Id": "tedi-real",
			"X-Tedix-Acting-User": "U-real",
			"X-Tedix-Jev-Attestation": "runtime-proof",
		});
		applyInboundTrustHeaderHygiene(headers, true);
		expect(headers.get("X-Service-Binding")).toBe("true");
		expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-real");
		expect(headers.get("X-Tedix-Acting-User")).toBe("U-real");
		expect(headers.get("X-Tedix-Jev-Attestation")).toBe("runtime-proof");
	});

	it("makes a browser-forged service-binding claim resolve as a NON-binding (user) request", () => {
		// A browser forges the master trust flag. Relayed by a proxy over an
		// internal binding, the downstream would trust the forged identity
		// headers as a service call.
		const forged = new Headers({ "X-Service-Binding": "true" });
		expect(isServiceBinding(forged)).toBe(true);
		// After ingress hygiene the flag is gone, so the downstream falls through
		// to user-JWT auth (authType="user"), never the service-binding branch.
		applyInboundTrustHeaderHygiene(forged, false);
		expect(isServiceBinding(forged)).toBe(false);
	});
});

describe("isServiceBinding", () => {
	it("trusts only the explicit marker, never a synthetic Host", () => {
		expect(isServiceBinding(new Headers({ "X-Service-Binding": "true" }))).toBe(
			true,
		);
		expect(isServiceBinding(new Headers({ Host: "api" }))).toBe(false);
	});
});

describe("stripServiceBindingMarker", () => {
	it("removes a spoofed marker from public ingress", () => {
		const spoofed = new Request("https://api.example.test/rpc", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Tedi-Id": "tedi-forged",
			},
			body: "{}",
		});
		const stripped = stripServiceBindingMarker(spoofed);
		expect(isServiceBinding(stripped.headers)).toBe(false);
		expect(stripped.method).toBe("POST");
	});

	it("returns an unmarked request unchanged", () => {
		const request = new Request("https://api.example.test/rpc");
		expect(stripServiceBindingMarker(request)).toBe(request);
	});
});

describe("extractBearerToken", () => {
	it("parses case-insensitively and trims the token", () => {
		expect(extractBearerToken("bearer   token ")).toBe("token");
	});

	it("rejects missing and empty values", () => {
		expect(extractBearerToken(null)).toBeNull();
		expect(extractBearerToken("Bearer   ")).toBeNull();
	});

	it("stays linear on long whitespace runs that cannot match", () => {
		const hostile = `bearer ${" ".repeat(100_000)}\n`;
		const started = performance.now();
		expect(extractBearerToken(hostile)).toBeNull();
		expect(performance.now() - started).toBeLessThan(200);
	});
});

describe("WebSocket bearer subprotocols", () => {
	it("prefers bearer-<token>, then the bearer pair", () => {
		expect(extractWebSocketBearerToken("bearer, pair, bearer-prefixed")).toBe(
			"prefixed",
		);
		expect(extractWebSocketBearerToken("bearer, pair")).toBe("pair");
		expect(extractWebSocketBearerToken("bearer")).toBeNull();
		expect(extractWebSocketBearerToken(null)).toBeNull();
	});

	it("echoes one offered authentication protocol", () => {
		expect(pickEchoableSubprotocol("other, bearer-token")).toBe("bearer-token");
		expect(pickEchoableSubprotocol("bearer, token")).toBe("bearer");
		expect(pickEchoableSubprotocol("other")).toBeNull();
		expect(pickEchoableSubprotocol(null)).toBeNull();
	});
});

describe("secureEqual", () => {
	it("matches equal non-empty secrets", async () => {
		await expect(secureEqual("secret", "secret")).resolves.toBe(true);
	});

	it("rejects mismatches and empty configuration", async () => {
		await expect(secureEqual("wrong", "secret")).resolves.toBe(false);
		await expect(secureEqual("", "")).resolves.toBe(false);
		await expect(secureEqual("anything", undefined)).resolves.toBe(false);
	});
});
