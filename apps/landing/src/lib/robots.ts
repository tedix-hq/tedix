import { PUBLIC_ROBOTS_CONTENT_SIGNAL } from "./content-signals";

const ALLOWED_AI_DISCOVERY_CRAWLERS = [
	"GPTBot",
	"OAI-SearchBot",
	"ChatGPT-User",
	"ClaudeBot",
	"PerplexityBot",
	"Google-Extended",
	"GoogleOther",
	"Cloudflare-AI-Search",
	"CloudflareBrowserRenderingCrawler",
] as const;

const BLOCKED_TRAINING_CRAWLERS = [
	"Bytespider",
	"CCBot",
	"meta-externalagent",
	"Amazonbot",
] as const;

export function buildPublicRobotsTxt(
	sitemapUrl: URL,
	blogSitemapUrl?: string,
): string {
	return [
		"# Public content: searchable and usable for query-time AI answers, not training",
		...ALLOWED_AI_DISCOVERY_CRAWLERS.map((crawler) => `User-agent: ${crawler}`),
		`Content-Signal: ${PUBLIC_ROBOTS_CONTENT_SIGNAL}`,
		"Allow: /",
		"",
		"# Default policy for all other crawlers",
		"User-agent: *",
		`Content-Signal: ${PUBLIC_ROBOTS_CONTENT_SIGNAL}`,
		"Allow: /",
		"",
		"# Block training-only scrapers that do not cite",
		...BLOCKED_TRAINING_CRAWLERS.flatMap((crawler, index) => [
			`User-agent: ${crawler}`,
			"Disallow: /",
			...(index < BLOCKED_TRAINING_CRAWLERS.length - 1 ? [""] : []),
		]),
		"",
		`Sitemap: ${sitemapUrl.href}`,
		...(blogSitemapUrl ? [`Sitemap: ${blogSitemapUrl}`] : []),
	].join("\n");
}
