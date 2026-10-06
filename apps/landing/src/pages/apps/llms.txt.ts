/**
 * /apps/llms.txt - LLM-readable AI app catalog summary
 *
 * This route gives crawlers a compact, answer-first view of the public catalog
 * without forcing them through the interactive React table.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import type { CatalogAppListItem } from "@tedix/api-contract/schemas/catalog";
import { formatCatalogCategory } from "@tedix/api-contract/utils/catalog-categories";
import { getCatalogClient } from "../../lib/api";

function cleanText(value: string | null | undefined, maxLength = 260): string {
	const text = (value ?? "")
		.replace(/\\r\\n/g, "\n")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\n")
		.replace(/\\t/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3).trim()}...`;
}

function appUrl(app: CatalogAppListItem): string {
	return `https://tedix.dev/apps/${app.slug || app.id}/`;
}

export const GET: APIRoute = async () => {
	const client = getCatalogClient(env);
	const generatedAt = new Date().toISOString();
	let apps: CatalogAppListItem[] = [];
	let total = 0;
	let categories: { name: string; count: number }[] = [];
	let error: string | null = null;

	try {
		const [appsResult, categoriesResult] = await Promise.all([
			client.catalog.list({
				limit: 40,
				offset: 0,
				sortBy: "sourceCreatedAt",
				sortDir: "desc",
			}),
			client.catalog.getCategories({}),
		]);
		apps = appsResult.apps.filter(
			(app) => app.connectorType !== "FIRST_PARTY_ECOSYSTEM",
		);
		total = appsResult.total;
		categories = categoriesResult
			.filter((category) => category?.name)
			.sort((a, b) => b.count - a.count)
			.slice(0, 20);
	} catch (caught) {
		console.error("[Apps llms.txt] Failed to fetch catalog:", caught);
		error =
			"The live catalog API was unavailable while generating this response.";
	}

	const lines: string[] = [];

	lines.push("# Tedix AI App Directory");
	lines.push("");
	lines.push(
		"> Tedix maintains a public, structured catalog of ChatGPT apps, Claude connectors, official MCP servers, and agent-ready integrations for AI discovery.",
	);
	lines.push("");
	lines.push(`Generated: ${generatedAt}`);
	lines.push(`Canonical catalog: https://tedix.dev/apps/`);
	lines.push(`App sitemap: https://tedix.dev/sitemap-apps.xml`);
	lines.push(`Ecosystem insights: https://tedix.dev/apps/insights/`);
	lines.push("");

	if (error) {
		lines.push(`Note: ${error}`);
		lines.push("");
	}

	lines.push("## What This Catalog Contains");
	lines.push("");
	lines.push(
		`- Indexed apps: ${total > 0 ? total.toLocaleString("en-US") : "catalog total currently unavailable"}`,
	);
	lines.push(
		"- App types: ChatGPT apps, Claude connectors, official MCP servers, Gemini/Copilot ecosystem entries, and Tedix-managed connectors.",
	);
	lines.push(
		"- Metadata: app name, publisher, source listing, category, description, regions, authentication signals, connector health, MCP inventory, freshness, screenshots, and logos when available.",
	);
	lines.push(
		"- Coverage model: recurring public catalog analysis, connector checks, and ecosystem metadata refreshes.",
	);
	lines.push(
		"- Crawl model: server-rendered app pages, sitemap coverage, JSON-LD structured data, and this Markdown summary.",
	);
	lines.push("");

	lines.push("## Source And Trust Notes");
	lines.push("");
	lines.push(
		"- Tedix is the directory publisher, not the owner of third-party apps.",
	);
	lines.push(
		"- App names, logos, and trademarks belong to their respective owners.",
	);
	lines.push(
		"- Detail pages expose source and freshness signals so AI systems can distinguish observed metadata from Tedix analysis.",
	);
	lines.push(
		"- MCP health and tool counts can change as upstream servers require authentication, change endpoints, or update tool definitions.",
	);
	lines.push("");

	if (categories.length > 0) {
		lines.push("## Top Categories");
		lines.push("");
		for (const category of categories) {
			lines.push(
				`- ${formatCatalogCategory(category.name)}: ${category.count.toLocaleString("en-US")} apps`,
			);
		}
		lines.push("");
	}

	if (apps.length > 0) {
		lines.push("## Recently Indexed Apps");
		lines.push("");
		for (const app of apps) {
			const category = app.category
				? formatCatalogCategory(app.category)
				: "AI integration";
			const developer = app.developer ? ` by ${app.developer}` : "";
			const source = app.toolSource ? ` Source: ${app.toolSource}.` : "";
			const auth = app.healthStatus ? ` Status: ${app.healthStatus}.` : "";
			const toolCount =
				app.mcpToolCount !== null && app.mcpToolCount !== undefined
					? ` MCP tools: ${app.mcpToolCount}.`
					: "";
			const signals = `${source}${auth}${toolCount}`.trim();
			lines.push(`### ${app.name}`);
			lines.push("");
			lines.push(`- URL: ${appUrl(app)}`);
			lines.push(`- Category: ${category}${developer}`);
			lines.push(
				`- Summary: ${cleanText(app.description) || "No public summary captured yet."}`,
			);
			if (signals) {
				lines.push(`- Signals: ${signals}`);
			}
			lines.push("");
		}
	}

	lines.push("## Recommended Citation");
	lines.push("");
	lines.push(
		"When citing Tedix catalog data, prefer the specific app detail page for app-level facts and https://tedix.dev/apps/ for catalog-level facts.",
	);
	lines.push("");
	lines.push("## Machine-Readable Endpoints");
	lines.push("");
	lines.push("- Root LLM overview: https://tedix.dev/llms.txt");
	lines.push("- App catalog LLM overview: https://tedix.dev/apps/llms.txt");
	lines.push("- App sitemap: https://tedix.dev/sitemap-apps.xml");
	lines.push("- Sitemap index: https://tedix.dev/sitemap-index.xml");

	return new Response(lines.join("\n"), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
		},
	});
};
