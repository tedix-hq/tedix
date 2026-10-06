import assert from "node:assert/strict";

import {
	applyContentSignal,
	applyEdgeCacheHeaders,
	EDGE_CACHE_EXCLUDED_PREFIXES,
} from "../src/edge-cache-headers";

function htmlResponse(
	init: { status?: number; headers?: HeadersInit } = {},
): Response {
	return new Response("<html></html>", {
		status: init.status ?? 200,
		headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers },
	});
}

// Every public tenant GET/HEAD response is uncacheable. Vary: Host remains
// defense in depth, but no test may treat it as the isolation boundary.
for (const method of ["GET", "HEAD"]) {
	for (const status of [200, 301, 302, 400, 404, 500, 503]) {
		const res = applyEdgeCacheHeaders(
			htmlResponse({ status }),
			method,
			"/posts/hello",
		);
		assert.equal(
			res.headers.get("Cache-Control"),
			"private, no-store",
			`${method} status ${status} must not enter a shared cache`,
		);
		assert.equal(res.headers.get("Vary"), "Host");
	}
}

// Tenant-provided public cache policy must be overridden. This covers native
// robots.txt and redirects, both observed crossing tenant boundaries live.
{
	const res = applyEdgeCacheHeaders(
		htmlResponse({ headers: { "Cache-Control": "public, max-age=86400" } }),
		"GET",
		"/robots.txt",
	);
	assert.equal(res.headers.get("Cache-Control"), "private, no-store");
	assert.equal(res.headers.get("Vary"), "Host");
}

// Existing private policy is normalized and retains the defense-in-depth host
// variant. Set-Cookie remains intact.
{
	const res = applyEdgeCacheHeaders(
		htmlResponse({
			headers: {
				"Cache-Control": "no-store",
				"Set-Cookie": "session=abc; Path=/",
			},
		}),
		"GET",
		"/posts/hello",
	);
	assert.equal(res.headers.get("Cache-Control"), "private, no-store");
	assert.equal(res.headers.get("Set-Cookie"), "session=abc; Path=/");
	assert.equal(res.headers.get("Vary"), "Host");
}

// Non-GET/HEAD methods are not rewritten by the public response policy.
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
	const res = applyEdgeCacheHeaders(htmlResponse(), method, "/posts/hello");
	assert.equal(res.headers.get("Cache-Control"), null);
	assert.equal(res.headers.get("Vary"), null);
}

// Internal, admin, auth, and asset paths are governed by their own handlers.
for (const prefix of EDGE_CACHE_EXCLUDED_PREFIXES) {
	const res = applyEdgeCacheHeaders(htmlResponse(), "GET", `${prefix}x`);
	assert.equal(res.headers.get("Cache-Control"), null);
	assert.equal(res.headers.get("Vary"), null);
}

// Host matching is case-insensitive and must not be duplicated; other fields
// survive unchanged.
{
	const res = applyEdgeCacheHeaders(
		htmlResponse({ headers: { Vary: "Accept-Encoding, host" } }),
		"GET",
		"/posts/hello",
	);
	assert.equal(res.headers.get("Vary"), "Accept-Encoding, host");
}
{
	const res = applyEdgeCacheHeaders(
		htmlResponse({ headers: { Vary: "Accept-Encoding" } }),
		"GET",
		"/posts/hello",
	);
	assert.equal(res.headers.get("Vary"), "Accept-Encoding, Host");
}

// Response body/status/statusText survive the policy rewrite.
{
	const original = htmlResponse({ status: 200 });
	const res = applyEdgeCacheHeaders(original, "GET", "/posts/hello");
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "<html></html>");
}

// Content-Signal must reach AI crawlers on tenant documents.
{
	const html = applyContentSignal(htmlResponse());
	assert.equal(
		html.headers.get("Content-Signal"),
		"ai-train=no, search=yes, ai-input=yes",
	);

	const bin = applyContentSignal(
		new Response("x", { headers: { "Content-Type": "image/png" } }),
	);
	assert.equal(bin.headers.get("Content-Signal"), null);

	const preset = applyContentSignal(
		new Response("<html></html>", {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Signal": "search=no",
			},
		}),
	);
	assert.equal(preset.headers.get("Content-Signal"), "search=no");
}

console.log("cms-runtime edge cache headers check passed");
