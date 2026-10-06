import assert from "node:assert/strict";

import { resolveSlugFromHost } from "./slug-routing";

function resolve(rawUrl: string, allowQueryFallback: boolean): string | null {
	const url = new URL(rawUrl);
	return resolveSlugFromHost(url.hostname, url, allowQueryFallback);
}

// --- Hostname resolution (public ingress) ---------------------------------
{
	assert.equal(
		resolve("https://cto.tedi.tedix.dev/mcp", false),
		"cto",
		"resolves slug from a {slug}.tedi.tedix.dev hostname",
	);
	assert.equal(
		resolve("https://cto.tedi.tedix.tech/mcp", false),
		"cto",
		"resolves slug on the tedix.tech platform domain",
	);
	assert.equal(
		resolve("https://cfo.tedi.tedi.club/mcp", false),
		null,
		"does not resolve a slug on the retired tedi.club platform domain",
	);
	assert.equal(
		resolve("https://CTO.Tedi.Tedix.Dev/mcp", false),
		"cto",
		"hostname parsing is case-insensitive",
	);
}

// --- Non-tenant hostnames --------------------------------------------------
{
	assert.equal(
		resolve("https://tedi.tedix.dev/mcp", false),
		null,
		"bare tedi.{domain} has no slug",
	);
	assert.equal(
		resolve("https://a.b.tedi.tedix.dev/mcp", false),
		null,
		"a multi-label prefix is not a valid slug",
	);
	assert.equal(
		resolve("https://example.com/mcp", false),
		null,
		"unrelated hostnames resolve to no slug",
	);
}

// --- SECURITY: client ?slug= cannot override the hostname-resolved slug ----
// This is the confused-deputy regression guard. A public request that reaches a
// real tenant hostname must resolve to THAT tenant regardless of any attacker-
// supplied ?slug= query parameter — even if the query fallback were (wrongly)
// permitted for this request.
{
	assert.equal(
		resolve("https://victim.tedi.tedix.dev/mcp?slug=attacker", false),
		"victim",
		"hostname wins over ?slug= when query fallback is NOT allowed",
	);
	assert.equal(
		resolve("https://victim.tedi.tedix.dev/mcp?slug=attacker", true),
		"victim",
		"hostname wins over ?slug= even when query fallback IS allowed",
	);
	assert.equal(
		resolve("https://victim.tedi.tedix.tech/mcp?slug=attacker&x=1", true),
		"victim",
		"hostname authority holds across platform domains and extra params",
	);
}

// --- Trusted service-binding self-call fallback ----------------------------
// The neutral internal host used by service-binding forwards does not match the
// public pattern, so it yields no hostname slug and must fall back to ?slug=,
// but ONLY when the caller is a trusted service binding.
{
	assert.equal(
		resolve("https://tedi-runtime/mcp?slug=cto", true),
		"cto",
		"trusted service binding may use ?slug= when hostname yields no slug",
	);
	assert.equal(
		resolve("https://internal-host/mcp?slug=cto", false),
		null,
		"untrusted caller cannot use ?slug= as a slug source (fail closed)",
	);
	assert.equal(
		resolve("https://tedi-runtime/mcp", true),
		null,
		"trusted service binding with no ?slug= and no hostname slug resolves to null",
	);
}

console.log("slug-routing.test.ts: all assertions passed");
