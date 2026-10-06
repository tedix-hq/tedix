import { getHubPages, getUpdates } from "../../lib/docs-hubs";

export const prerender = true;

function escapeXml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&apos;",
			})[character]!,
	);
}

export async function GET() {
	const siteUrl = process.env.TEDIX_DOCS_SITE_URL;
	const title = process.env.TEDIX_DOCS_TITLE;
	if (!siteUrl || !title)
		throw new Error("Missing site URL or title for Docs RSS");
	const updates = getUpdates(await getHubPages());
	const home = new URL("/updates/", siteUrl).href;
	const items = updates
		.map((page) => {
			const link = new URL(page.href, siteUrl).href;
			return `<item><title>${escapeXml(page.title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="true">${escapeXml(link)}</guid><description>${escapeXml(page.description)}</description><pubDate>${page.date!.toUTCString()}</pubDate></item>`;
		})
		.join("");
	const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(title)} updates</title><link>${escapeXml(home)}</link><description>Published documentation updates</description>${items}</channel></rss>`;
	return new Response(xml, {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
}
