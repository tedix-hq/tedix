/// <reference types="node" />
import { describe, expect, it, vi } from "vite-plus/test";

// Astro and Nimbus are installed in the build image, not the control Worker:
// stand in for them and import the real template config.
vi.mock("@cloudflare/nimbus-docs", () => ({
	default: () => ({}),
	defineConfig: (config: unknown) => config,
}));
vi.mock("@cloudflare/nimbus-docs/markdown", () => ({
	tableScroll: () => ({}),
}));
vi.mock("@tailwindcss/vite", () => ({ default: () => ({}) }));
vi.mock("astro/config", () => ({ defineConfig: (config: unknown) => config }));
// The build settings the template requires at load.
vi.stubEnv("TEDIX_DOCS_SITE_URL", "https://docs.example.invalid");
vi.stubEnv("TEDIX_DOCS_TITLE", "Example");
vi.stubEnv("TEDIX_DOCS_DESCRIPTION", "Example documentation");
vi.stubEnv("TEDIX_DOCS_SITE_SLUG", "tedix");
// A computed specifier keeps tsc from type-checking the template against
// packages this Worker does not install.
const templatePath = "../template/astro.config";
const {
	dataUsesCustomLayout,
	documentationLinks,
	docsSidebarItems,
	omitAuthoredHtmlTitle,
} = (await import(/* @vite-ignore */ templatePath)) as {
	dataUsesCustomLayout: (data: Record<string, unknown>) => boolean;
	documentationLinks: () => {
		element: {
			visit: (
				node: unknown,
				context?: unknown,
			) => { properties: { href: string } } | undefined;
		};
	};
	omitAuthoredHtmlTitle: () => {
		element: {
			visit: (
				node: unknown,
				context: {
					data: Record<string, unknown>;
					removeNode: (node: unknown) => void;
					source: string;
				},
			) => void;
		};
	};
	docsSidebarItems: ReadonlyArray<{
		label: string;
		collapsed: boolean;
		items: readonly string[];
	}>;
};
const visit = documentationLinks().element.visit as (
	node: unknown,
	context?: unknown,
) => { properties: { href: string } };
describe("Nimbus documentation navigation", () => {
	it("removes the authored H1 from a standard page", () => {
		const node = {
			type: "element",
			tagName: "h1",
			properties: {},
			children: [],
		};
		const removeNode = vi.fn();

		omitAuthoredHtmlTitle().element.visit(node, {
			data: { astro: { frontmatter: { title: "Guide", mode: "doc" } } },
			removeNode,
			source: "# Guide",
		});

		expect(removeNode).toHaveBeenCalledWith(node);
	});

	it("preserves the authored H1 for a custom page", () => {
		const data = {
			astro: { frontmatter: { title: "Landing", mode: "custom" } },
		};
		const removeNode = vi.fn();

		expect(dataUsesCustomLayout(data)).toBe(true);
		omitAuthoredHtmlTitle().element.visit(
			{ type: "element", tagName: "h1", properties: {}, children: [] },
			{ data, removeNode, source: "# Authored title" },
		);

		expect(removeNode).not.toHaveBeenCalled();
	});

	it("groups every public page into a small task-led sidebar", () => {
		expect(docsSidebarItems.map((group) => group.label)).toEqual([
			"Start",
			"Troubleshoot",
			"Work with digital workers",
			"Publish with Tedix",
			"Install and operate",
			"For agents and maintainers",
		]);
		expect(docsSidebarItems[0]?.collapsed).toBe(false);
		expect(docsSidebarItems.flatMap((group) => group.items)).toEqual([
			"getting-started",
			"learning-paths/first-connection",
			"learning-paths/first-worker",
			"concepts",
			"release-status",
			"troubleshooting",
			"workers-and-governance",
			"skills-flows-workflows",
			"mcp-app-platform",
			"docs-sites",
			"cms",
			"cli",
			"self-hosted-boundary",
			"installation-manifests",
			"cloudflare-architecture",
			"dependency-pins",
			"telemetry",
			"agent-guide",
			"agents",
			"licensing",
		]);
	});

	it.each([
		["getting-started.md", "cli.md", "/cli"],
		[
			"learning-paths/first-worker.md",
			"first-connection.md",
			"/learning-paths/first-connection",
		],
		["guides/setup.md", "../CLI.md#Install", "/cli#Install"],
		["guides/index.mdx", "advanced.md", "/guides/advanced"],
	])(
		"resolves links from %s independently of the browser trailing slash",
		(source, href, expected) => {
			const result = visit(
				{ properties: { href } },
				{
					fileURL: new URL(`file:///opt/site/src/content/docs/${source}`),
				},
			).properties.href;
			for (const suffix of ["", "/"]) {
				const base = `https://docs.tedix.dev/${source.replace(/\.mdx?$/, "")}${suffix}`;
				expect(
					new URL(result, base).pathname + new URL(result, base).hash,
				).toBe(expected);
			}
		},
	);

	it.each([
		["getting-started.md", "/getting-started"],
		["../platform/ARCHITECTURE.md#Runtime", "/platform/architecture#Runtime"],
		["/guides/setup.mdx?mode=cloud#start", "/guides/setup?mode=cloud#start"],
	])("routes %s to its human-readable page", (href, expected) => {
		expect(
			visit(
				{
					type: "element",
					tagName: "a",
					properties: { href },
					children: [],
				},
				{ fileURL: new URL("file:///opt/site/src/content/docs/guide.md") },
			).properties.href,
		).toBe(expected);
	});
	it.each([
		"https://example.invalid/guide.md",
		"//example.invalid/guide.md",
		"#section",
		"/llms.txt",
		"mailto:docs@example.invalid",
	])("preserves explicit resource %s", (href) => {
		expect(
			visit({ type: "element", tagName: "a", properties: { href } }),
		).toBeUndefined();
	});
});
