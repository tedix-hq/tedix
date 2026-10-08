/** Site overview for /llms.txt. */
import type { APIRoute } from "astro";
export const GET: APIRoute = () => {
	const lines: string[] = [];

	lines.push("# Tedix");
	lines.push("");
	lines.push(
		"> AI coworkers that show their work. Tedix gives teams AI coworkers (tedis) for recurring work: they ask before risky steps, and every run leaves a record of what was done, with which tools, and who approved it. Open source, runs on Cloudflare.",
	);
	lines.push("");
	lines.push(
		"Tedix Cloud is in invited beta. The Tedix CLI is in public beta. The source is public on GitHub under AGPL-3.0-only (some packages are Apache-2.0 or MIT); local mode runs from a checkout without an invitation. Self-hosting is experimental and unsupported.",
	);
	lines.push("");

	lines.push("## Source and status");
	lines.push("");
	lines.push(
		"- [Source on GitHub](https://github.com/tedix-hq/tedix): Product source; issues and Discussions welcome, pull requests are disabled",
	);
	lines.push(
		"- [Documentation](https://docs.tedix.dev/): Getting started, release status and the self-hosted boundary",
	);
	lines.push(
		"- CLI install: `curl -fsSL https://downloads.tedix.dev/install.sh | sh`",
	);
	lines.push(
		"- Local mode: `git clone https://github.com/tedix-hq/tedix.git && cd tedix && bun run-local`",
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
		"- [Tedix Homepage](https://tedix.dev): AI coworkers that show their work",
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
