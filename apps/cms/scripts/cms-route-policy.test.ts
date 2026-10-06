import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
	canonicalPublicUrl,
	comparableUrl,
	normalizePublicPathPrefix,
	publicSurfacePath,
} from "./cms-route-policy";

// A reverse-proxied tenant: only /guide is mounted on the CMS; the public
// root belongs to the tenant's own origin.
const prefixedTenant = {
	publicBaseUrl: "https://www.acme.example",
	publicPathPrefix: "/guide",
	publicRootOwnedByCms: false,
};

// A tenant whose whole public host is owned by the CMS, with no prefix.
const rootTenant = { publicBaseUrl: "https://blog.globex.example" };

describe("template route middleware", () => {
	for (const template of ["tedix", "marketing"]) {
		test(`${template} keeps canonical slash handling without posts compatibility redirects`, () => {
			const source = readFileSync(
				new URL(`../templates/${template}/src/middleware.ts`, import.meta.url),
				"utf8",
			);
			expect(source).toContain("CANONICAL_SLASH_ROUTE_RE");
			expect(source).toContain("CANONICAL_ROOT_CONTENT_TRAILING_RE");
			// A slashed root content path is rendered in place, never 301'd back:
			// browsers keep the permanent /apps -> /apps/ redirect earlier
			// deployments sent, and a reverse redirect loops them forever.
			expect(source).toContain(
				'return next(`${pathname.replace(/\\/+$/, "")}${search}`);',
			);
			expect(source).not.toContain("getPublicSiteUrl");
			expect(source).not.toContain('collectionIndexHref("posts"');
			expect(source).not.toContain("postsIndexPath");
		});
	}
});

describe("publicSurfacePath", () => {
	test.each([
		["/robots.txt", "/guide/robots.txt"],
		["/sitemap.xml", "/guide/sitemap.xml"],
		["/llms.txt", "/guide/llms.txt"],
		["/rss.xml", "/guide/rss.xml"],
	])(
		"mounts discovery path %s under the tenant prefix",
		(canonical, expected) => {
			// Live: /guide/llms.txt and /guide/rss.xml are CMS 200s while the
			// unprefixed paths 404 on the tenant's own origin, and unprefixed
			// /robots.txt and /sitemap.xml are the TENANT's own files — checking them
			// graded a server the CMS does not own.
			expect(publicSurfacePath(prefixedTenant, canonical)).toBe(expected);
		},
	);

	test("leaves already-prefixed collection and post paths alone", () => {
		expect(publicSurfacePath(prefixedTenant, "/guide/")).toBe("/guide/");
		expect(publicSurfacePath(prefixedTenant, "/guide/some-post")).toBe(
			"/guide/some-post",
		);
		expect(publicSurfacePath(prefixedTenant, "/guide/some-post.md")).toBe(
			"/guide/some-post.md",
		);
	});

	test("skips the site root the customer owns", () => {
		expect(publicSurfacePath(prefixedTenant, "")).toBeNull();
		expect(publicSurfacePath(prefixedTenant, "/")).toBeNull();
	});

	test("leaves an unprefixed tenant untouched", () => {
		expect(publicSurfacePath(rootTenant, "/llms.txt")).toBe("/llms.txt");
		expect(publicSurfacePath(rootTenant, "")).toBe("");
		expect(publicSurfacePath(rootTenant, "/")).toBe("/");
	});
});

describe("canonicalPublicUrl", () => {
	test.each([
		["", "https://www.acme.example/guide/"],
		["/", "https://www.acme.example/guide/"],
		["/sitemap.xml", "https://www.acme.example/guide/sitemap.xml"],
		["/llms.txt", "https://www.acme.example/guide/llms.txt"],
		["/rss.xml", "https://www.acme.example/guide/rss.xml"],
	])("expects %s to canonicalize onto the prefix", (canonical, expected) => {
		// Matches the live origin 301s. A redirect that dropped /guide used to
		// pass as "origin canonical redirect" because only the host was compared.
		expect(canonicalPublicUrl(prefixedTenant, canonical)).toBe(expected);
	});

	test("maps the internal /posts route onto the public prefix", () => {
		expect(canonicalPublicUrl(prefixedTenant, "/posts")).toBe(
			"https://www.acme.example/guide/",
		);
		expect(canonicalPublicUrl(prefixedTenant, "/posts/")).toBe(
			"https://www.acme.example/guide/",
		);
		expect(canonicalPublicUrl(prefixedTenant, "/posts/my-slug")).toBe(
			"https://www.acme.example/guide/my-slug",
		);
	});

	test("does NOT prefix robots.txt, which the origin never redirects", () => {
		// isOriginRedirectablePath() excludes /robots.txt; the origin serves its
		// own noindex robots at 200. Prefixing here would invent a contract.
		expect(canonicalPublicUrl(prefixedTenant, "/robots.txt")).toBe(
			"https://www.acme.example/robots.txt",
		);
	});

	test("an unprefixed tenant canonicalizes to the bare public path", () => {
		expect(canonicalPublicUrl(rootTenant, "/sitemap.xml")).toBe(
			"https://blog.globex.example/sitemap.xml",
		);
		expect(canonicalPublicUrl(rootTenant, "")).toBe(
			"https://blog.globex.example/",
		);
	});
});

describe("normalizePublicPathPrefix", () => {
	test.each([
		[undefined, null],
		["", null],
		["/", null],
		["guide", "/guide"],
		["/guide/", "/guide"],
	])("normalizes %s", (input, expected) => {
		expect(normalizePublicPathPrefix(input)).toBe(expected);
	});
});

describe("comparableUrl", () => {
	test("ignores a trailing slash but not a dropped path segment", () => {
		expect(comparableUrl("https://x.dev/guide/")).toBe(
			comparableUrl("https://x.dev/guide"),
		);
		expect(comparableUrl("https://x.dev/guide/sitemap.xml")).not.toBe(
			comparableUrl("https://x.dev/sitemap.xml"),
		);
	});
});
