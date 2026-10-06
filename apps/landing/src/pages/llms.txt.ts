/** Site overview for /llms.txt. */
import type { APIRoute } from "astro";
export const GET: APIRoute = () => {
	const lines: string[] = [];

	lines.push("# Tedix");
	lines.push("");
	lines.push(
		"> Tedix is a platform for autonomous digital workers (tedis) that build AI-powered apps, create content, and operate infrastructure end-to-end.",
	);
	lines.push("");
	lines.push(
		"Tedix enables businesses to deploy AI-native experiences across ChatGPT, Claude, and other AI platforms. Each customer gets a tedi — an autonomous AI worker that learns the business, generates AEO-optimized content, and operates MCP apps.",
	);
	lines.push("");

	const blogBase = "https://tedix.dev";

	lines.push("## Blog");
	lines.push("");
	lines.push(`- [Blog](${blogBase}/blog): Latest articles and insights`);
	lines.push(`- [Blog sitemap](${blogBase}/sitemap-posts.xml)`);
	lines.push("");

	// Platform links
	lines.push("## Platform");
	lines.push("");
	lines.push(
		"- [Tedix Homepage](https://tedix.dev): AI That Learns Your Business",
	);
	lines.push(
		"- [AI App Directory](https://tedix.dev/apps): Browse AI apps across ChatGPT, Claude, and more",
	);
	lines.push(
		"- [Public REST API catalog](https://api.tedix.dev/openapi.json): Canonical OpenAPI 3.1 description",
	);
	lines.push(
		"- [Public REST API reference](https://api.tedix.dev/docs): Human-readable Scalar reference",
	);
	lines.push("- [Contact](https://tedix.dev/contact): Get in touch");
	lines.push("");

	// MCP section
	lines.push("## MCP Apps");
	lines.push("");
	lines.push(
		"- [Tedix MCP Server](https://tedix.mcp.tedix.dev): Platform administration and management tools",
	);
	lines.push(
		"- Each customer app has its own MCP server at {slug}.mcp.tedix.dev with domain-specific tools",
	);

	return new Response(lines.join("\n"), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
