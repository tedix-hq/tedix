type PortableRecord = Record<string, unknown>;

type RenderOptions = {
	origin: string;
	faqHeading: string;
};

type TocItem = {
	id: string;
	text: string;
	depth: 2 | 3;
};

export type MediaLike =
	| string
	| {
			src?: string;
			url?: string;
			alt?: string;
			caption?: string;
			alignment?: string;
			meta?: { storageKey?: string };
			asset?: { url?: string };
			id?: string;
			storageKey?: string;
	  }
	| null
	| undefined;

function asRecord(value: unknown): PortableRecord {
	return typeof value === "object" && value !== null
		? (value as PortableRecord)
		: {};
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function escapeMarkdown(value: unknown): string {
	return String(value ?? "")
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
}

function isSafeHref(href: string): boolean {
	return /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(href);
}

function isSafeMediaUrl(url: string): boolean {
	return /^(https?:\/\/|\/)/i.test(url);
}

function getChildren(block: PortableRecord): PortableRecord[] {
	return Array.isArray(block.children) ? block.children.map(asRecord) : [];
}

function getPlainText(block: PortableRecord): string {
	return getChildren(block)
		.map((child) => asString(child.text) ?? "")
		.join("");
}

function createSlugger() {
	const seen = new Map<string, number>();
	return (text: string, fallback: string) => {
		const base =
			text
				.normalize("NFKD")
				.toLowerCase()
				.replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
				.trim()
				.replace(/\s+/g, "-")
				.replace(/-+/g, "-") || fallback;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count + 1}`;
	};
}

function markDefs(block: PortableRecord): Map<string, PortableRecord> {
	const defs = Array.isArray(block.markDefs)
		? block.markDefs.map(asRecord)
		: [];
	return new Map(
		defs.flatMap((def) => {
			const key = asString(def._key);
			return key ? [[key, def] as const] : [];
		}),
	);
}

function renderSpanMarkdown(
	span: PortableRecord,
	defs: Map<string, PortableRecord>,
): string {
	let text = escapeMarkdown(span.text ?? "");
	const marks = Array.isArray(span.marks) ? span.marks : [];
	for (const mark of marks) {
		const markName = String(mark);
		const def = defs.get(markName);
		const href = def ? (asString(def.href) ?? asString(def.url)) : null;
		if (href && isSafeHref(href)) {
			text = `[${text}](${href})`;
		} else if (markName === "strong") {
			text = `**${text}**`;
		} else if (markName === "em") {
			text = `_${text}_`;
		} else if (markName === "code") {
			text = `\`${text.replace(/[\\`]/g, "\\$&")}\``;
		}
	}
	return text;
}

function renderInlineMarkdown(block: PortableRecord): string {
	const defs = markDefs(block);
	return getChildren(block)
		.map((span) => renderSpanMarkdown(span, defs))
		.join("");
}

export function resolveMediaUrl(
	media: MediaLike,
	origin: string,
): string | null {
	if (!media) return null;
	if (typeof media === "string") return media;
	const direct = media.src ?? media.url ?? media.asset?.url;
	if (direct) return isSafeMediaUrl(direct) ? direct : null;
	const key = media.meta?.storageKey ?? media.storageKey ?? media.id;
	return key ? `${origin}/_emdash/api/media/file/${key}` : null;
}

function renderImageMarkdown(block: PortableRecord, origin: string): string {
	const src = resolveMediaUrl(block as MediaLike, origin);
	if (!src) return "";
	const alt = asString(block.alt) ?? "";
	const caption = asString(block.caption) ?? asString(block.title);
	return caption
		? `![${escapeMarkdown(alt)}](${src})\n\n_${escapeMarkdown(caption)}_`
		: `![${escapeMarkdown(alt)}](${src})`;
}

function renderTableMarkdown(block: PortableRecord): string {
	const rows = Array.isArray(block.rows) ? block.rows.map(asRecord) : [];
	if (!rows.length) return "";
	const values = rows.map((row) =>
		(Array.isArray(row.cells) ? row.cells.map(asRecord) : []).map((cell) => {
			const value = Array.isArray(cell.content)
				? cell.content
						.map(asRecord)
						.map((span) => String(span.text ?? ""))
						.join("")
				: String(cell.text ?? cell.value ?? "");
			return value.replace(/[\\|]/g, "\\$&").trim();
		}),
	);
	const width = Math.max(...values.map((row) => row.length));
	const normalized = values.map((row) => [
		...row,
		...Array(Math.max(0, width - row.length)).fill(""),
	]);
	const header = normalized[0] ?? [];
	const separator = header.map(() => "---");
	return [header, separator, ...normalized.slice(1)]
		.map((row) => `| ${row.join(" | ")} |`)
		.join("\n");
}

function renderFaqMarkdown(block: PortableRecord, heading: string): string {
	const items = Array.isArray(block.items)
		? block.items.map(asRecord).flatMap((item) => {
				const question = asString(item.question)?.trim();
				const answer = asString(item.answer)?.trim();
				return question && answer ? [{ question, answer }] : [];
			})
		: [];
	if (!items.length) return "";
	const headline = asString(block.headline)?.trim() || heading;
	return [
		`## ${headline}`,
		...items.map((item) => `### ${item.question}\n\n${item.answer}`),
	].join("\n\n");
}

function renderCodeMarkdown(block: PortableRecord): string {
	const code =
		asString(block.code) ?? asString(block.value) ?? asString(block.text);
	if (!code) return "";
	const language = asString(block.language) ?? "";
	return `\`\`\`${language}\n${code.replace(/```/g, "\\`\\`\\`")}\n\`\`\``;
}

function renderCustomMarkdown(
	block: PortableRecord,
	options: RenderOptions,
): string {
	const type = asString(block._type);
	if (!type) return "";
	if (type === "table") return renderTableMarkdown(block);
	if (type === "marketing.faq" || type === "faq")
		return renderFaqMarkdown(block, options.faqHeading);
	if (type === "image" || type === "media" || type === "figure")
		return renderImageMarkdown(block, options.origin);
	if (type === "code") return renderCodeMarkdown(block);
	if (type === "htmlBlock" || type === "html")
		return asString(block.html) ?? asString(block.value) ?? "";
	if (type.includes("callout")) {
		const text = asString(block.text) ?? getPlainText(block);
		return text ? `> ${text}` : "";
	}
	if (type.includes("quote") || type === "pullquote") {
		const text =
			asString(block.text) ?? asString(block.quote) ?? getPlainText(block);
		const citation = asString(block.citation);
		return text ? `> ${text}${citation ? `\n>\n> ${citation}` : ""}` : "";
	}
	return "";
}

function renderBlockMarkdown(block: PortableRecord): string {
	const style = asString(block.style) ?? "normal";
	const text = renderInlineMarkdown(block);
	if (!text.trim()) return "";
	if (style === "blockquote") return `> ${text}`;
	const headingMatch = /^h([1-4])$/.exec(style);
	if (headingMatch) return `${"#".repeat(Number(headingMatch[1]))} ${text}`;
	return text;
}

export function getPortableToc(blocks: unknown[]): TocItem[] {
	const slug = createSlugger();
	return blocks.map(asRecord).flatMap((block, index) => {
		if (block._type !== "block") return [];
		const style = asString(block.style);
		if (style !== "h2" && style !== "h3") return [];
		const text = getPlainText(block).trim();
		return text
			? [
					{
						id: slug(text, `section-${index}`),
						text,
						depth: style === "h2" ? 2 : 3,
					},
				]
			: [];
	});
}

export function portableToMarkdown(
	blocks: unknown[],
	options: RenderOptions,
): string {
	const output: string[] = [];
	for (let index = 0; index < blocks.length; index += 1) {
		const block = asRecord(blocks[index]);
		if (block._type === "block" && block.listItem) {
			const items: string[] = [];
			let counter = 1;
			while (index < blocks.length) {
				const listBlock = asRecord(blocks[index]);
				if (listBlock._type !== "block" || !listBlock.listItem) break;
				const prefix =
					listBlock.listItem === "number" || listBlock.listItem === "ordered"
						? `${counter}.`
						: "-";
				items.push(`${prefix} ${renderInlineMarkdown(listBlock)}`);
				counter += 1;
				index += 1;
			}
			index -= 1;
			output.push(items.join("\n"));
			continue;
		}
		const rendered =
			block._type === "block"
				? renderBlockMarkdown(block)
				: renderCustomMarkdown(block, options);
		if (rendered) output.push(rendered);
	}
	return output.join("\n\n");
}
