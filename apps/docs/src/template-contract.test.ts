import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const templateDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../template",
);

describe("public docs template contracts", () => {
	it("uses declared or exported provenance without a Git fallback", async () => {
		const [page, home, config, dockerfile] = await Promise.all([
			readFile(join(templateDir, "page.astro"), "utf8"),
			readFile(join(templateDir, "index.astro"), "utf8"),
			readFile(join(templateDir, "astro.config.ts"), "utf8"),
			readFile(join(templateDir, "../Dockerfile"), "utf8"),
		]);
		expect(page).toContain(
			"entry.data.lastUpdated ?? await getProvenanceLastUpdated(entry)",
		);
		expect(page).not.toContain("getLastUpdated");
		expect(home).toContain("getProvenanceLastUpdated(entry)");
		expect(home).toContain("lastUpdated={lastUpdated}");
		expect(home).toContain('property: "article:modified_time"');
		expect(config).toContain("sitemap: { serialize: sitemapLastUpdated }");
		expect(dockerfile).toContain(
			"template/src/lib/docs-provenance.ts /opt/tedix-docs-template/src/lib/docs-provenance.ts",
		);
		expect(dockerfile).toContain(
			"template/src/lib/sitemap-last-updated.ts /opt/tedix-docs-template/src/lib/sitemap-last-updated.ts",
		);
	});

	it("targets current public pages from agent setup", async () => {
		const source = await readFile(
			join(templateDir, "agent-setup.astro"),
			"utf8",
		);
		expect(source).toContain('=== "workers-and-governance"');
		expect(source).toContain('=== "mcp-app-platform"');
		expect(source).toContain('=== "agent-guide"');
		expect(source).not.toContain('=== "digital-workers"');
		expect(source).not.toContain('=== "governance-and-audit"');
	});

	it("uses the shared bounded copy fallback on both entry pages", async () => {
		const [home, agentSetup] = await Promise.all([
			readFile(join(templateDir, "index.astro"), "utf8"),
			readFile(join(templateDir, "agent-setup.astro"), "utf8"),
		]);
		for (const source of [home, agentSetup]) {
			expect(source).toContain("copyTextWithFallback");
			expect(source).toContain('button.textContent = "Copying…"');
			expect(source).toContain('copied ? "Copied" : "Copy failed"');
		}
	});

	it("pins the certified Nimbus 0.15 image compatibility boundary", async () => {
		const [dockerfile, config, header, layout, handoff] = await Promise.all([
			readFile(join(templateDir, "../Dockerfile"), "utf8"),
			readFile(join(templateDir, "astro.config.ts"), "utf8"),
			readFile(join(templateDir, "Header.astro"), "utf8"),
			readFile(join(templateDir, "DocsLayout.astro"), "utf8"),
			readFile(join(templateDir, "AgentPageHandoff.astro"), "utf8"),
		]);
		expect(dockerfile).toContain("@cloudflare/create-nimbus-docs@0.7.7");
		expect(dockerfile).toContain("@cloudflare/nimbus-docs@0.15.0 --exact");
		expect(config).toContain("preserveSymlinks: true");
		for (const source of [config, header, layout, handoff]) {
			expect(source).not.toContain("astro-icon");
		}
		for (const source of [header, layout, handoff]) {
			expect(source).toContain("@cloudflare/nimbus-docs/components/Icon.astro");
		}
	});

	it("uses a layout-aware renderer instead of hiding authored titles", async () => {
		const [page, config, theme] = await Promise.all([
			readFile(join(templateDir, "page.astro"), "utf8"),
			readFile(join(templateDir, "astro.config.ts"), "utf8"),
			readFile(join(templateDir, "tedix-theme.css"), "utf8"),
		]);

		expect(page).not.toContain("hasContentTitle");
		expect(config).toContain("omitAuthoredHtmlTitle()");
		expect(config).toContain("dataUsesCustomLayout(context.data)");
		expect(theme).not.toContain(".td-authored-title");
	});

	it("places an access-neutral page handoff beside page actions", async () => {
		const [layout, handoff] = await Promise.all([
			readFile(join(templateDir, "DocsLayout.astro"), "utf8"),
			readFile(join(templateDir, "AgentPageHandoff.astro"), "utf8"),
		]);

		expect(layout).toContain("<PageActions markdownUrl={markdownUrl}");
		expect(layout).toContain("{markdownUrl && <AgentPageHandoff />}");
		expect(handoff).toContain("currentPageMarkdownUrl(window.location.href)");
		expect(handoff).toContain("pageAgentPrompt(markdownUrl)");
		expect(handoff).toContain("copyTextWithFallback");
		expect(handoff).toContain("Copy agent prompt");
		expect(handoff).toContain("/agent-setup/#copy-and-start");
	});
});
