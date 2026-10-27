/** Site overview for /llms.txt. */
import type { APIRoute } from "astro";
import { defaultLocale, getLocaleContent } from "../i18n/content";
export const GET: APIRoute = () => {
	const { meta } = getLocaleContent(defaultLocale);
	const lines: string[] = [];

	lines.push(`# ${meta.title}`);
	lines.push("");
	lines.push(`> ${meta.description} Open source, runs on Cloudflare.`);
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

	lines.push("## For agents");
	lines.push(
		"- [Review Tedix for your project](https://github.com/tedix-hq/tedix/blob/main/AGENT-REVIEW.md): 15-minute agent review and feedback intake; no login or CLI",
	);
	lines.push("");
	lines.push(
		"- [Start here as an agent](https://docs.tedix.dev/agent-start-here/): Connect, bind a project, work a Work Item, deliver an Output",
	);
	lines.push(
		"- [Factories, Workspaces and Projects](https://docs.tedix.dev/factories-workspaces-projects/): Which record holds what",
	);
	lines.push(
		"- [Track sessions per project](https://docs.tedix.dev/sessions-per-project/): Where Claude Code and Codex sessions show up in Tedix OS",
	);
	lines.push(
		"- [Documentation index for agents](https://docs.tedix.dev/llms.txt): Every public docs page, one line each",
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
		"- [Tedix Homepage](https://tedix.dev): A platform for agents, apps, and work",
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
		"- [Tedix Connect](https://connect.mcp.tedix.dev/mcp): Connect AI assistants to your organization's tasks, project knowledge, apps, decisions, and results through MCP",
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
