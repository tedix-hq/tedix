import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createRoutesFromEntries } from "../templates/marketing/node_modules/astro/dist/core/routing/create-manifest.js";
import { Router } from "../templates/marketing/node_modules/astro/dist/core/routing/router.js";

function starterRoutes(template: "marketing" | "tedix") {
	const pages = fileURLToPath(
		new URL(`../templates/${template}/src/pages/`, import.meta.url),
	);
	const entries: Array<{ path: string; isDir: boolean }> = [];
	function walk(directory: string, prefix = "") {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			entries.push({ path, isDir: entry.isDirectory() });
			if (entry.isDirectory()) walk(join(directory, entry.name), path);
		}
	}
	walk(pages);
	const settings = {
		config: { output: "server", base: "/", trailingSlash: "ignore" },
		pageExtensions: [],
	} as unknown as Parameters<typeof createRoutesFromEntries>[1];
	const logger = { warn: () => undefined } as unknown as Parameters<
		typeof createRoutesFromEntries
	>[2];
	const routes = createRoutesFromEntries(entries, settings, logger);
	const router = new Router(routes, {
		base: "/",
		trailingSlash: "ignore",
		buildFormat: "directory",
	});
	return {
		routes,
		match(path: string) {
			const result = router.match(path);
			return result.type === "match" ? result.route.route : null;
		},
	};
}

describe.each(["marketing", "tedix"] as const)(
	"%s starter locale routes",
	(template) => {
		it("routes localized content to explicit pages before the generic catchall", () => {
			const { match } = starterRoutes(template);
			expect(match("/fr/")).toBe(
				template === "marketing" ? "/[slug]" : "/[locale]",
			);
			expect(match("/fr/about/")).toBe(
				template === "marketing" ? "/[locale]/[slug]" : "/[...path]",
			);
			if (template === "tedix") {
				expect(match("/fr/pages/about/")).toBe("/[locale]/pages/[slug]");
			} else {
				expect(match("/fr/pages/rc-block-proof/")).toBe(
					"/[locale]/pages/[slug]",
				);
			}
			expect(match("/fr/posts/")).toBe("/[locale]/posts");
			expect(match("/fr/posts/preuve-archive-native/")).toBe(
				"/[locale]/posts/[slug]",
			);
			// Astro gives the .md catchall precedence over a dynamic locale route.
			// Its handler dispatches conventional localized posts before native patterns.
			expect(match("/fr/posts/preuve-archive-native.md")).toBe("/[...path].md");
			expect(match("/fr/category/archive-proof/")).toBe(
				"/[locale]/category/[slug]",
			);
			expect(match("/fr/tag/archive-proof/")).toBe("/[locale]/tag/[slug]");
		});

		it("keeps default-locale routes at the root without a competing SSR pattern", () => {
			const { routes, match } = starterRoutes(template);
			expect(match("/posts/native-taxonomy-archive-proof/")).toBe(
				"/posts/[slug]",
			);
			expect(match("/category/archive-proof/")).toBe("/category/[slug]");
			if (template === "tedix") {
				expect(match("/pages/about/")).toBe("/[...path]");
			} else {
				expect(match("/pages/rc-block-proof/")).toBe("/pages/[slug]");
			}
			const patterns = routes
				.filter((route) => route.type === "page")
				.map((route) => route.pattern.source);
			expect(new Set(patterns).size).toBe(patterns.length);
		});
	},
);
