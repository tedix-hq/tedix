import nimbus, {
	defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { configuredSidebarItems } from "./docs-navigation";
import { sitemapLastUpdated } from "./src/lib/sitemap-last-updated";

// Source files retain repository-relative Markdown links. Human navigation
// targets Nimbus HTML routes; absolute machine-readable URLs stay unchanged.
export function documentationLinks(): ReturnType<typeof tableScroll> {
	return {
		name: "tedix:documentation-links",
		element: {
			filter: ["a"],
			visit(node, context) {
				const href = node.properties?.href;
				if (
					typeof href !== "string" ||
					/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)
				)
					return;
				const match = /^([^?#]+)\.mdx?([?#].*)?$/i.exec(href);
				if (!match) return;
				// Nimbus serves each source file as a directory route. Resolve in
				// source space first, not relative to that rendered directory.
				const sourcePath =
					context.fileURL?.pathname.split("/src/content/docs/")[1];
				if (!href.startsWith("/") && !sourcePath) {
					throw new Error(
						`Cannot resolve documentation link without its source page: ${href}`,
					);
				}
				const target = new URL(
					href,
					`https://docs.invalid/${sourcePath ?? ""}`,
				);
				const route = target.pathname.replace(/\.mdx?$/i, "").toLowerCase();
				return {
					...node,
					properties: {
						...node.properties,
						href: `${route}${target.search}${target.hash}`,
					},
				};
			},
		},
	};
}

export function dataUsesCustomLayout(data: Record<string, unknown>): boolean {
	const astro = data.astro;
	if (!astro || typeof astro !== "object") return false;
	const frontmatter = (astro as Record<string, unknown>).frontmatter;
	return (
		Boolean(frontmatter) &&
		typeof frontmatter === "object" &&
		(frontmatter as Record<string, unknown>).mode === "custom"
	);
}

// Standard pages already render their title in DocsLayout. Custom pages own
// their complete body, including their authored title, so leave those alone.
export function omitAuthoredHtmlTitle(): ReturnType<typeof tableScroll> {
	return {
		name: "tedix:omit-authored-html-title",
		element: {
			filter: ["h1"],
			visit(node, context) {
				if (dataUsesCustomLayout(context.data)) return;
				context.removeNode(node);
			},
		},
	};
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required build setting ${name}`);
	return value;
}

export const docsSidebarItems = configuredSidebarItems(
	required("TEDIX_DOCS_SITE_SLUG"),
);

const nimbusConfig = defineNimbusConfig({
	site: required("TEDIX_DOCS_SITE_URL"),
	title: required("TEDIX_DOCS_TITLE"),
	description: required("TEDIX_DOCS_DESCRIPTION"),
	locale: process.env.TEDIX_DOCS_LOCALE || "en",
	homeLabel: "Docs",
	github: process.env.TEDIX_DOCS_REPOSITORY_URL || null,
	socialImageAlt: `${required("TEDIX_DOCS_TITLE")} documentation preview`,
	sidebar: {
		items: docsSidebarItems,
		// Nimbus still opens the group containing the current page. Keep Start
		// visible so a first-time reader always has an obvious next step.
		defaultCollapsed: true,
	},
});

export default defineConfig({
	output: "static",
	// Tenant builds symlink the image's pinned dependencies into an isolated
	// workspace. Vite 8/Rolldown must keep that logical path so Astro's compiled
	// module and its virtual style modules share one cache key.
	vite: {
		plugins: [tailwindcss()],
		resolve: { preserveSymlinks: true },
	},
	prefetch: { prefetchAll: true, defaultStrategy: "hover" },
	integrations: [
		nimbus(nimbusConfig, {
			sitemap: { serialize: sitemapLastUpdated },
			rules: {
				"nimbus/frontmatter-shape": "error",
				"nimbus/internal-link": "error",
			},
			markdown: {
				hastPlugins: [
					omitAuthoredHtmlTitle(),
					documentationLinks(),
					tableScroll(),
				],
			},
		}),
	],
});
