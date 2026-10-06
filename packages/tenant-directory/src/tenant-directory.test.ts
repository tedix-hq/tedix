import { describe, expect, test } from "vite-plus/test";
import {
	buildSurfaceUrl,
	normalizeSurfaceHostname,
	platformDomainForEnvironment,
	resolveSurfaceTenant,
	SURFACE_SLUG_PATTERN,
	type SurfaceTenant,
} from "./index";

test("maps Worker environments to the one canonical platform domain", () => {
	expect(platformDomainForEnvironment("production")).toBe("tedix.dev");
	expect(platformDomainForEnvironment("development")).toBe("tedix.tech");
});

/** Mirror of the internal DNS-label check for the regex table below. */
function isDnsSlug(label: string): boolean {
	return label.length <= 63 && SURFACE_SLUG_PATTERN.test(label);
}

// =============================================================================
// Reference oracles — the four historical parsers, reproduced verbatim, so the
// behavior-preservation table below asserts against the exact old logic rather
// than against a hand-transcribed expectation. Each surface asserts that the
// unified resolver yields the SAME downstream decision the old parser gave for
// every real (provisionable) tenant, plus the apex / launcher / local /
// custom-domain / dev-host cases the surfaces branch on.
// =============================================================================

// ── OS (apps/os/src/lib/os-tenant.ts, pre-migration) ─────────────────────────
type OldOsRoute =
	| { kind: "tenant"; slug: string }
	| { kind: "launcher" }
	| { kind: "local"; slug: string | null }
	| { kind: "invalid" };

function oldResolveOsTenant(hostname: string): OldOsRoute {
	const MANAGED = ".os.tedix.dev";
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!host) return { kind: "invalid" };
	if (host === "os.tedix.dev") return { kind: "launcher" };
	if (host === "localhost" || host === "127.0.0.1") {
		return { kind: "local", slug: null };
	}
	if (host.endsWith(".localhost")) {
		const slug = host.slice(0, -".localhost".length);
		return slug ? { kind: "local", slug } : { kind: "invalid" };
	}
	if (!host.endsWith(MANAGED)) return { kind: "invalid" };
	const slug = host.slice(0, -MANAGED.length);
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
		return { kind: "invalid" };
	}
	return { kind: "tenant", slug };
}

/** Re-derive the OS route from the unified resolver (mirror of apps/os). */
function newResolveOsTenant(hostname: string): OldOsRoute {
	const r = resolveSurfaceTenant(hostname, {
		platformDomain: "tedix.dev",
		expectedSurface: "os",
	});
	if (r.surface !== "os") return { kind: "invalid" };
	if (r.kind === "tenant" && r.slug) return { kind: "tenant", slug: r.slug };
	if (r.kind === "apex") return { kind: "launcher" };
	if (r.kind === "local") return { kind: "local", slug: r.slug };
	return { kind: "invalid" };
}

// ── MCP (apps/mcp/src/hostname.ts, pre-migration) ────────────────────────────
type OldMcpInfo = {
	type: "subdomain" | "custom" | "base_domain";
	appSlug?: string;
	customDomain?: string;
};

function oldExtractAppFromHostname(
	hostname: string,
	baseDomains: string[],
): OldMcpInfo {
	const hostWithoutPort = hostname.split(":")[0] ?? hostname;
	for (const baseDomain of baseDomains) {
		if (hostWithoutPort === baseDomain) return { type: "base_domain" };
		if (hostWithoutPort.endsWith(`.${baseDomain}`)) {
			const appSlug = hostWithoutPort.slice(0, -(baseDomain.length + 1));
			if (appSlug && /^[a-z0-9-]+$/i.test(appSlug)) {
				return { type: "subdomain", appSlug: appSlug.toLowerCase() };
			}
		}
	}
	return { type: "custom", customDomain: hostWithoutPort };
}

/** Adapter mirror of apps/mcp/src/hostname.ts (post-migration). */
function newExtractAppFromHostname(
	hostname: string,
	baseDomains: string[],
): OldMcpInfo {
	const base = baseDomains[0];
	const host = normalizeSurfaceHostname(hostname);
	if (!base) return { type: "custom", customDomain: host };
	const dot = base.indexOf(".");
	const platformDomain = dot === -1 ? null : base.slice(dot + 1);
	if (!platformDomain) return { type: "custom", customDomain: host };
	const r = resolveSurfaceTenant(hostname, {
		platformDomain,
		expectedSurface: "mcp",
	});
	if (r.surface === "mcp" && r.kind === "apex") return { type: "base_domain" };
	if (r.surface === "mcp" && r.kind === "tenant" && r.slug) {
		return { type: "subdomain", appSlug: r.slug };
	}
	return { type: "custom", customDomain: host };
}

// ── CMS (apps/cms-runtime/src/index.ts, pre-migration) ───────────────────────
function oldCmsExtractSlug(
	hostname: string,
	environment: string,
): string | null {
	const patterns: Record<string, RegExp> = {
		production: /^([a-z0-9][a-z0-9-]+)\.cms\.tedix\.dev$/,
		development: /^([a-z0-9][a-z0-9-]+)\.cms\.tedix\.tech$/,
	};
	const pattern = patterns[environment] ?? patterns.production!;
	return hostname.match(pattern)?.[1] ?? null;
}

function newCmsExtractSlug(
	hostname: string,
	environment: string,
): string | null {
	const resolved = resolveSurfaceTenant(hostname, {
		platformDomain: platformDomainForEnvironment(environment),
		expectedSurface: "cms",
	});
	return resolved.kind === "tenant" ? resolved.slug : null;
}

// ── Tedi (packages/db/src/utils/tedi-routing.ts, pre-migration) ──────────────
function oldParseTediHostname(
	hostname: string,
	platformDomain = "tedix.dev",
): { tediSlug: string } | null {
	let host = hostname.trim().toLowerCase();
	const bracketEnd = host.indexOf("]");
	const colonIdx = host.indexOf(":", bracketEnd + 1);
	if (colonIdx !== -1) host = host.slice(0, colonIdx);
	if (host.endsWith(".")) host = host.slice(0, -1);
	const suffix = `.tedi.${platformDomain}`;
	if (!host.endsWith(suffix)) return null;
	const prefix = host.slice(0, -suffix.length);
	if (!prefix || prefix.includes(".")) return null;
	return { tediSlug: prefix };
}

function newParseTediHostname(
	hostname: string,
	platformDomain = "tedix.dev",
): { tediSlug: string } | null {
	const r = resolveSurfaceTenant(hostname, {
		platformDomain,
		expectedSurface: "tedi",
	});
	return r.surface === "tedi" && r.kind === "tenant" && r.slug
		? { tediSlug: r.slug }
		: null;
}

// Every host here is a REAL, provisionable slug (or an explicit apex / local /
// custom / malformed case). For provisionable slugs the old and new parsers
// must agree exactly; malformed labels only ever differ on NON-provisionable
// input, where both paths 404 downstream — asserted separately.
const REAL_SLUGS = ["globex", "acme", "a", "ab", "my-workspace", "x1", "n8n"];

describe("canonical slug regex", () => {
	test("is the RFC-1035 DNS label rule provisioning already enforces", () => {
		// Matches the organizations-contract provisioning form character rule.
		for (const slug of REAL_SLUGS) {
			expect(SURFACE_SLUG_PATTERN.test(slug)).toBe(true);
			expect(isDnsSlug(slug)).toBe(true);
		}
		expect(isDnsSlug("-bad")).toBe(false);
		expect(isDnsSlug("bad-")).toBe(false);
		expect(isDnsSlug("bad_slug")).toBe(false);
		expect(isDnsSlug("a".repeat(63))).toBe(true);
		expect(isDnsSlug("a".repeat(64))).toBe(false);
		// The 63-char DNS cap is enforced by hostname routing, not the regex.
		expect(SURFACE_SLUG_PATTERN.test("a".repeat(64))).toBe(true);
		expect(
			resolveSurfaceTenant(`${"a".repeat(64)}.os.tedix.dev`, {
				expectedSurface: "os",
			}).kind,
		).toBe("invalid");
	});
});

describe("normalizeSurfaceHostname", () => {
	test("trims, lowercases, strips port and trailing dot", () => {
		expect(normalizeSurfaceHostname("  ACME.MCP.Tedix.DEV.  ")).toBe(
			"acme.mcp.tedix.dev",
		);
		expect(normalizeSurfaceHostname("acme.tedi.tedix.dev:8787")).toBe(
			"acme.tedi.tedix.dev",
		);
		expect(normalizeSurfaceHostname("[::1]:3000")).toBe("[::1]");
	});
});

describe("OS behavior preservation", () => {
	const hosts = [
		...REAL_SLUGS.map((s) => `${s}.os.tedix.dev`),
		"os.tedix.dev", // launcher
		"localhost", // local(null)
		"127.0.0.1", // local(null)
		"acme.localhost", // local(acme)
		".localhost", // invalid (empty label)
		"app.tedix.dev", // invalid — non-surface apex
		"-bad.os.tedix.dev", // invalid — leading hyphen
		"a.b.os.tedix.dev", // invalid — multi-label
		"", // invalid — empty
	];

	test("re-derives the exact old OS route for every host", () => {
		for (const host of hosts) {
			expect(newResolveOsTenant(host)).toEqual(oldResolveOsTenant(host));
		}
	});

	test("the launcher/tenant/local kinds stay distinct", () => {
		expect(newResolveOsTenant("globex.os.tedix.dev")).toEqual({
			kind: "tenant",
			slug: "globex",
		});
		expect(newResolveOsTenant("os.tedix.dev")).toEqual({ kind: "launcher" });
		expect(newResolveOsTenant("acme.localhost")).toEqual({
			kind: "local",
			slug: "acme",
		});
		expect(newResolveOsTenant("localhost")).toEqual({
			kind: "local",
			slug: null,
		});
	});
});

describe("MCP behavior preservation", () => {
	const prod = ["mcp.tedix.dev"];
	const dev = ["mcp.tedix.tech"];

	test("re-derives the old MCP HostnameInfo for provisionable + apex hosts", () => {
		const cases: Array<[string, string[]]> = [
			...REAL_SLUGS.map(
				(s) => [`${s}.mcp.tedix.dev`, prod] as [string, string[]],
			),
			["mcp.tedix.dev", prod], // base_domain
			["mcp.tedix.tech", dev], // dev base_domain
			["tedix-unified.mcp.tedix.tech", dev], // dev subdomain
			["blog.example.com", prod], // custom domain
			["a.b.mcp.tedix.dev", prod], // dotted → custom
			["tedix.mcp.tedix.tech", prod], // wrong env → custom
		];
		for (const [host, base] of cases) {
			expect(newExtractAppFromHostname(host, base)).toEqual(
				oldExtractAppFromHostname(host, base),
			);
		}
	});

	test("resolves the documented subdomain / base_domain / custom kinds", () => {
		expect(newExtractAppFromHostname("acme.mcp.tedix.dev", prod)).toEqual({
			type: "subdomain",
			appSlug: "acme",
		});
		expect(newExtractAppFromHostname("mcp.tedix.dev", prod)).toEqual({
			type: "base_domain",
		});
		expect(newExtractAppFromHostname("blog.example.com", prod)).toEqual({
			type: "custom",
			customDomain: "blog.example.com",
		});
	});
});

describe("CMS behavior preservation", () => {
	test("re-derives the old production slug for provisionable + apex hosts", () => {
		const hosts = [
			...REAL_SLUGS.filter((s) => s.length >= 2).map(
				(s) => `${s}.cms.tedix.dev`,
			),
			"cms.tedix.dev", // apex → null → custom lookup
			"blog.example.com", // custom → null
		];
		for (const host of hosts) {
			expect(newCmsExtractSlug(host, "production")).toBe(
				oldCmsExtractSlug(host, "production"),
			);
		}
	});

	test("dev host canonicalizes to cms.tedix.tech (drift bugfix)", () => {
		expect(newCmsExtractSlug("acme.cms.tedix.tech", "development")).toBe(
			"acme",
		);
		expect(
			newCmsExtractSlug("acme.cms.example.test", "development"),
		).toBeNull();
	});

	test("apex and custom domains fall through to the DB lookup (null)", () => {
		expect(newCmsExtractSlug("cms.tedix.dev", "production")).toBeNull();
		expect(newCmsExtractSlug("builder.tedix.dev", "production")).toBeNull();
		expect(newCmsExtractSlug("blog.example.com", "production")).toBeNull();
	});

	test("resolves a valid 1-char slug the old min-2 regex misrouted (superset)", () => {
		// Old CMS required >=2 chars, so `a.cms.tedix.dev` fell to a custom-domain
		// lookup that missed even though `a` is a provisionable org slug. The
		// canonical RFC-1035 regex (1-char OK) now routes it correctly. This ADDS
		// a real tenant to resolution; it never drops one.
		expect(oldCmsExtractSlug("a.cms.tedix.dev", "production")).toBeNull();
		expect(newCmsExtractSlug("a.cms.tedix.dev", "production")).toBe("a");
	});
});

describe("Tedi behavior preservation", () => {
	test("re-derives the old tedi slug for provisionable hosts", () => {
		const hosts = [
			...REAL_SLUGS.map((s) => `${s}.tedi.tedix.dev`),
			"acme.tedi.tedix.dev:8787", // port → same tenant
			"acme.tedi.tedix.dev.", // trailing dot → same tenant
			"blog.example.com", // custom → null
			"a.b.tedi.tedix.dev", // multi-label → null
		];
		for (const host of hosts) {
			expect(newParseTediHostname(host)).toEqual(oldParseTediHostname(host));
		}
	});

	test("honors the dev platform domain", () => {
		expect(newParseTediHostname("acme.tedi.tedix.tech", "tedix.tech")).toEqual({
			tediSlug: "acme",
		});
	});

	test("hands unrecognized hosts to the custom-domain lookup", () => {
		const r: SurfaceTenant = resolveSurfaceTenant("blog.example.com", {
			expectedSurface: "tedi",
		});
		expect(r).toEqual({
			surface: "tedi",
			slug: null,
			kind: "custom-domain",
		});
	});
});

describe("non-provisionable labels 404 either way", () => {
	// The looser historical MCP/Tedi/CMS regexes accepted labels that provisioning
	// can never mint (leading/trailing hyphen, underscores, >63 chars). Under the
	// canonical regex these become custom-domain / null instead of a bogus tenant
	// slug, but both resolutions miss in the DB — the real-tenant set is identical.
	test("MCP trailing-hyphen label becomes custom, not a phantom tenant", () => {
		expect(
			newExtractAppFromHostname("bad-.mcp.tedix.dev", ["mcp.tedix.dev"]),
		).toEqual({ type: "custom", customDomain: "bad-.mcp.tedix.dev" });
	});
	test("Tedi underscore label resolves to null (custom path)", () => {
		expect(newParseTediHostname("bad_slug.tedi.tedix.dev")).toBeNull();
	});
});

describe("buildSurfaceUrl", () => {
	test("emits the canonical URL per surface", () => {
		expect(buildSurfaceUrl("os", "acme")).toBe("https://acme.os.tedix.dev/");
		expect(buildSurfaceUrl("mcp", "acme")).toBe("https://acme.mcp.tedix.dev");
		expect(buildSurfaceUrl("mcp", "acme", { path: "endpoint" })).toBe(
			"https://acme.mcp.tedix.dev/mcp",
		);
		expect(buildSurfaceUrl("tedi", "acme")).toBe("https://acme.tedi.tedix.dev");
		expect(buildSurfaceUrl("cms", "acme")).toBe("https://acme.cms.tedix.dev");
	});

	test("threads the dev platform domain", () => {
		expect(
			buildSurfaceUrl("tedi", "acme", { platformDomain: "tedix.tech" }),
		).toBe("https://acme.tedi.tedix.tech");
	});

	test("returns null for a falsy slug (buildRuntimeUrl parity)", () => {
		expect(buildSurfaceUrl("tedi", null)).toBeNull();
		expect(buildSurfaceUrl("tedi", "")).toBeNull();
	});
});
