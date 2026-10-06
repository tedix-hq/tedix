import { getParentCookieDomain } from "@tedix/auth/web";
import { describe, expect, it } from "vite-plus/test";
import {
	isAgentAuthoredBytePath,
	isUntrustedContentPath,
	isUntrustedContentRequest,
	protectedCookieSuffixes,
	resolveUntrustedContentOrigin,
	untrustedContentBaseUrl,
} from "./untrusted-origin";

const PROD = {
	API_URL: "https://api.tedix.dev",
	OS_URL: "https://os.tedix.dev",
	MCP_UI_URL: "https://mcp-ui.tedix.dev",
	MCP_URL: "https://mcp.tedix.dev",
};

const OK = "https://artifacts.tedix-usercontent.example";

describe("resolveUntrustedContentOrigin — the three states stay distinct", () => {
	it("absent, empty and whitespace are all `unset`, never `configured`", () => {
		expect(resolveUntrustedContentOrigin(PROD)).toEqual({ state: "unset" });
		expect(
			resolveUntrustedContentOrigin({ ...PROD, UNTRUSTED_CONTENT_ORIGIN: "" }),
		).toEqual({ state: "unset" });
		expect(
			resolveUntrustedContentOrigin({
				...PROD,
				UNTRUSTED_CONTENT_ORIGIN: "   ",
			}),
		).toEqual({ state: "unset" });
	});

	it("accepts a domain outside every authenticated cookie jar", () => {
		expect(
			resolveUntrustedContentOrigin({
				...PROD,
				UNTRUSTED_CONTENT_ORIGIN: `${OK}/`,
			}),
		).toEqual({ state: "configured", origin: OK });
	});

	it("accepts a workers.dev origin (Public Suffix List isolates it)", () => {
		const workersDev = "https://tedix-artifacts.tedix.workers.dev";
		expect(
			resolveUntrustedContentOrigin({
				...PROD,
				UNTRUSTED_CONTENT_ORIGIN: workersDev,
			}),
		).toEqual({ state: "configured", origin: workersDev });
	});
});

describe("resolveUntrustedContentOrigin — cookie-jar refusals", () => {
	// The rejection is grounded in the real cookie scope, not an invented list:
	// packages/auth/src/web.ts scopes DS/DSR to the PARENT of the surface host,
	// so every host under that parent receives them.
	it("`.tedix.dev` really is the Dashboard's cookie scope", () => {
		expect(getParentCookieDomain("os.tedix.dev")).toBe(".tedix.dev");
		expect(getParentCookieDomain("chat.os.tedix.dev")).toBe(".os.tedix.dev");
	});

	for (const host of [
		"https://artifacts.tedix.dev",
		"https://tedix.dev",
		"https://artifacts.os.tedix.dev",
		"https://artifacts.tedix.tech",
	]) {
		it(`refuses ${host}`, () => {
			const resolution = resolveUntrustedContentOrigin({
				...PROD,
				UNTRUSTED_CONTENT_ORIGIN: host,
			});
			expect(resolution.state).toBe("invalid");
			if (resolution.state !== "invalid") throw new Error("unreachable");
			expect(resolution.reason).toContain("shares a cookie jar");
		});
	}

	it("refuses a self-hosted installation's own surface domain", () => {
		const resolution = resolveUntrustedContentOrigin({
			API_URL: "https://api.acme-internal.test",
			OS_URL: "https://console.acme-internal.test",
			UNTRUSTED_CONTENT_ORIGIN: "https://artifacts.acme-internal.test",
		});
		expect(resolution.state).toBe("invalid");
	});

	it("refuses an origin listed in CORS_ALLOWED_ORIGINS", () => {
		const resolution = resolveUntrustedContentOrigin({
			API_URL: "https://api.acme-internal.test",
			CORS_ALLOWED_ORIGINS: "https://os.example-tenant.test",
			UNTRUSTED_CONTENT_ORIGIN: "https://artifacts.example-tenant.test",
		});
		expect(resolution.state).toBe("invalid");
	});

	it("refuses a different PORT on the same host — cookies ignore ports", () => {
		const resolution = resolveUntrustedContentOrigin({
			API_URL: "http://localhost:8787",
			UNTRUSTED_CONTENT_ORIGIN: "http://localhost:8788",
		});
		expect(resolution.state).toBe("invalid");
	});

	it("refuses plaintext http on a non-loopback host", () => {
		const resolution = resolveUntrustedContentOrigin({
			...PROD,
			UNTRUSTED_CONTENT_ORIGIN: "http://artifacts.tedix-usercontent.example",
		});
		expect(resolution.state).toBe("invalid");
		if (resolution.state !== "invalid") throw new Error("unreachable");
		expect(resolution.reason).toContain("must be https");
	});

	it("refuses a value carrying a path, query or fragment", () => {
		for (const value of [`${OK}/artifacts`, `${OK}/?a=1`, `${OK}/#x`]) {
			expect(
				resolveUntrustedContentOrigin({
					...PROD,
					UNTRUSTED_CONTENT_ORIGIN: value,
				}).state,
			).toBe("invalid");
		}
	});

	it("refuses a non-URL", () => {
		expect(
			resolveUntrustedContentOrigin({
				...PROD,
				UNTRUSTED_CONTENT_ORIGIN: "artifacts.example.test",
			}).state,
		).toBe("invalid");
	});

	it("protects the first-party sites unconditionally", () => {
		const suffixes = protectedCookieSuffixes({});
		expect(suffixes.has("tedix.dev")).toBe(true);
		expect(suffixes.has("tedix.tech")).toBe(true);
	});

	it("no longer protects the retired staging site", () => {
		expect(protectedCookieSuffixes({}).has("tedi.club")).toBe(false);
	});
});

describe("untrustedContentBaseUrl", () => {
	it("falls back to the API origin only while UNSET", () => {
		expect(untrustedContentBaseUrl(PROD, PROD.API_URL)).toBe(PROD.API_URL);
	});

	it("mints onto the untrusted origin once configured", () => {
		expect(
			untrustedContentBaseUrl(
				{ ...PROD, UNTRUSTED_CONTENT_ORIGIN: OK },
				PROD.API_URL,
			),
		).toBe(OK);
	});

	it("THROWS on an invalid origin — never silently mints onto the shared one", () => {
		expect(() =>
			untrustedContentBaseUrl(
				{ ...PROD, UNTRUSTED_CONTENT_ORIGIN: "https://artifacts.tedix.dev" },
				PROD.API_URL,
			),
		).toThrow(/shares a cookie jar/);
	});
});

describe("path classification", () => {
	it("the untrusted origin serves ONLY the two signed lanes", () => {
		expect(isUntrustedContentPath("/artifacts/s/tedi-1/art-1")).toBe(true);
		expect(isUntrustedContentPath("/artifacts/s/tedi-1/art-1/js/app.js")).toBe(
			true,
		);
		expect(isUntrustedContentPath("/skill-media/run-1/outputs/a.json")).toBe(
			true,
		);
		// Session lanes must NOT be served there — that origin never reads a cookie.
		expect(isUntrustedContentPath("/artifacts/tedi-1/art-1")).toBe(false);
		expect(isUntrustedContentPath("/skill-runs/run-1/media/a.png")).toBe(false);
		expect(isUntrustedContentPath("/rpc/tedis/list")).toBe(false);
		expect(isUntrustedContentPath("/v1/tedis")).toBe(false);
		expect(isUntrustedContentPath("/health")).toBe(false);
	});

	it('rejects the `tediId === "s"` shape collision', () => {
		// `/artifacts/s/art-1` is three segments: Hono matches it against the
		// SESSION route `/artifacts/:tediId/:artifactId` with tediId="s". A
		// startsWith("/artifacts/s/") gate would let that cookie-reading handler
		// run on the boundary origin.
		expect(isUntrustedContentPath("/artifacts/s/art-1")).toBe(false);
		expect(isUntrustedContentPath("/artifacts/s/")).toBe(false);
		expect(isUntrustedContentPath("/artifacts/s")).toBe(false);
		expect(isUntrustedContentPath("/skill-media/run-1")).toBe(false);
		expect(isUntrustedContentPath("/skill-media/run-1/")).toBe(false);
	});

	it("classifies every agent-authored byte path on the trusted origin", () => {
		expect(isAgentAuthoredBytePath("/artifacts/s/tedi-1/art-1")).toBe(true);
		expect(isAgentAuthoredBytePath("/artifacts/tedi-1/art-1")).toBe(true);
		expect(isAgentAuthoredBytePath("/skill-media/run-1/a.json")).toBe(true);
		expect(isAgentAuthoredBytePath("/skill-runs/run-1/media/a.png")).toBe(true);
		// Not agent-chosen content types — see the function's comment.
		expect(isAgentAuthoredBytePath("/os-exports/out-1/rev-1.pdf")).toBe(false);
		expect(isAgentAuthoredBytePath("/os-shared/tok")).toBe(false);
		expect(isAgentAuthoredBytePath("/skill-runs/run-1/status")).toBe(false);
		expect(isAgentAuthoredBytePath("/rpc/x")).toBe(false);
	});
});

describe("isUntrustedContentRequest", () => {
	const env = { ...PROD, UNTRUSTED_CONTENT_ORIGIN: OK };

	it("is true only on the configured origin", () => {
		expect(isUntrustedContentRequest(env, `${OK}/artifacts/s/a/b`)).toBe(true);
		expect(
			isUntrustedContentRequest(env, "https://api.tedix.dev/artifacts/s/a/b"),
		).toBe(false);
	});

	it("is false while unset, so nothing changes before provisioning", () => {
		expect(isUntrustedContentRequest(PROD, `${OK}/artifacts/s/a/b`)).toBe(
			false,
		);
	});
});
