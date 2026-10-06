/**
 * Per-page `/<slug>/index.md` — the clean-markdown alternate for every
 * indexable entry of the primary `docs` collection.
 *
 * Non-primary collections (`api`, `blog`, …) mount under their own
 * URL namespace by convention; their `.md` alternates live at the
 * sibling route `pages/<collection>/[...slug]/index.md.ts`. This route
 * filters to the primary collection so multi-collection sites don't
 * generate conflicting `[...slug]` paths at root.
 */

import {
	getIndexedEntries,
	renderEntryAsMarkdown,
	type IndexedEntry,
} from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const PRIMARY_COLLECTION = "docs";

interface SlugProps {
	item: IndexedEntry;
}

function resolvedPageHref(href: string, sourceId: string): string {
	if (
		/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href) ||
		!/^([^?#]+)\.mdx?([?#].*)?$/i.test(href)
	) {
		return href;
	}
	const sourcePath = `${sourceId.replace(/^\/+|\.mdx?$/gi, "")}.md`;
	const target = new URL(href, `https://docs.invalid/${sourcePath}`);
	return `${target.pathname.replace(/\.mdx?$/i, "").toLowerCase()}${target.search}${target.hash}`;
}

function rewriteInlineDestinations(line: string, sourceId: string): string {
	const rewrite = (value: string) =>
		value.replace(
			/(\]\(\s*<?)([^<>\s)]+)(>?)/g,
			(_match, prefix: string, href: string, suffix: string) =>
				`${prefix}${resolvedPageHref(href, sourceId)}${suffix}`,
		);

	let output = "";
	let proseStart = 0;
	let cursor = 0;
	while (cursor < line.length) {
		if (line[cursor] !== "`") {
			cursor += 1;
			continue;
		}
		let end = cursor + 1;
		while (line[end] === "`") end += 1;
		const delimiter = line.slice(cursor, end);
		const close = line.indexOf(delimiter, end);
		if (close === -1) break;
		output += rewrite(line.slice(proseStart, cursor));
		output += line.slice(cursor, close + delimiter.length);
		cursor = close + delimiter.length;
		proseStart = cursor;
	}
	return output + rewrite(line.slice(proseStart));
}

/** Resolve authored page links in the source page's directory, not the
 * generated `/<page>/index.md` directory used by Markdown clients. */
export function resolveMarkdownPageLinks(
	markdown: string,
	sourceId: string,
): string {
	let fence: { marker: "`" | "~"; length: number } | undefined;
	return markdown.replace(/[^\r\n]*(?:\r\n|\r|\n|$)/g, (line) => {
		if (!line) return line;
		const candidate = line.replace(/[\r\n]+$/, "");
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(candidate);
		if (fence) {
			if (
				opening?.[1]?.[0] === fence.marker &&
				opening[1].length >= fence.length &&
				/^\s*$/.test(candidate.slice(opening[0].length))
			) {
				fence = undefined;
			}
			return line;
		}
		if (opening) {
			fence = {
				marker: opening[1]![0] as "`" | "~",
				length: opening[1]!.length,
			};
			return line;
		}

		const definition =
			/^(\s{0,3}\[(?!\^)[^\]\r\n]+\]:\s*<?)([^<>\s]+)(>?)/.exec(candidate);
		const withDefinition = definition
			? `${candidate.slice(0, definition.index)}${definition[1]}${resolvedPageHref(definition[2]!, sourceId)}${definition[3]}${candidate.slice(definition[0].length)}`
			: candidate;
		return `${rewriteInlineDestinations(withDefinition, sourceId)}${line.slice(candidate.length)}`;
	});
}

export async function getStaticPaths() {
	const indexed = await getIndexedEntries();
	return indexed
		.filter((item) => item.collection === PRIMARY_COLLECTION)
		.map((item) => ({
			// Root index (`entry.id === "index"`) emits at `/index.md`; Astro's
			// rest-segment treats `undefined` as "no segment" so the URL is
			// `/index.md` rather than `/index/index.md`. Every other entry emits
			// at `/<entry.id>/index.md` — the convention `<page>/index.md`.
			params: {
				slug:
					item.entry.id.toLowerCase() === "index"
						? undefined
						: item.entry.id.toLowerCase() === "readme"
							? "readme"
							: item.entry.id,
			},
			props: { item } as SlugProps,
		}));
}

export async function GET({ props }: { props: SlugProps }) {
	const { item } = props;
	const { entry, title, description, markdownUrl, sourceUrl, version } = item;
	const data = (entry.data ?? {}) as Record<string, unknown>;
	const rawImage = data.socialImage;
	const socialImage =
		typeof rawImage === "string" && rawImage.length > 0
			? rawImage
			: config.socialImage;

	const markdown = resolveMarkdownPageLinks(
		renderEntryAsMarkdown(entry),
		entry.id,
	);

	const body = [
		"---",
		`title: ${JSON.stringify(title)}`,
		...(description ? [`description: ${JSON.stringify(description)}`] : []),
		...(socialImage
			? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`]
			: []),
		...(version ? [`version: ${JSON.stringify(version)}`] : []),
		"---",
		"",
		"> Documentation Index",
		`> Fetch the complete documentation index at: ${new URL("/llms.txt", config.site).href}`,
		"> Use this file to discover all available pages before exploring further.",
		"",
		/^\s*#\s+/.test(markdown) ? "" : `# ${title}`,
		"",
		markdown,
		"",
		// Point at the authored source (`.mdx` twin) when it exists — the
		// `.md` alternate referencing itself was a placeholder.
		`Source: ${new URL(sourceUrl ?? markdownUrl, config.site).href}`,
		"",
	].join("\n");

	return new Response(body, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
}
