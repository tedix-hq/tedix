/**
 * Safe Markdown → HTML for conversation surfaces.
 *
 * One renderer serves both the embedded Tedi widget (Shadow DOM, `innerHTML`)
 * and the native Tedix OS chat's link/sanitisation policy. The output is a
 * plain HTML string with no framework assumptions, built from these rules:
 *
 * - Every character that is not produced by a recognised Markdown construct is
 *   HTML-escaped. Raw HTML in the source is text, never markup.
 * - Bidi/direction controls are stripped before parsing (same set as
 *   `apps/os/src/lib/untrusted-text.ts`), so a tool name cannot reorder the
 *   operator's own sentence on screen.
 * - Links are emitted only for `https:` destinations (plus whatever the caller's
 *   `link` policy resolves, e.g. same-origin host routes) and always carry
 *   `rel="noopener noreferrer"`. Anything else stays literal text.
 * - Fenced code keeps its language as `class="language-<lang>"` and gets a copy
 *   affordance the host binds through {@link bindMarkdownCopyButtons}.
 */

const DIRECTION_CONTROL_PATTERN =
	/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Removes every bidi/direction control. Idempotent. */
export function stripBidiControls(value: string): string {
	return value.replace(DIRECTION_CONTROL_PATTERN, "");
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** HTML-escapes text for element content and attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}

/**
 * Default link policy: only absolute `https:` URLs are navigable. Returns the
 * normalised href or `null` when the destination must stay plain text.
 */
export function safeMarkdownHref(href: string): string | null {
	const trimmed = stripBidiControls(href).trim();
	if (!/^https:\/\/[^\s/?#]+/i.test(trimmed)) return null;
	try {
		return new URL(trimmed).href;
	} catch {
		return null;
	}
}

export interface MarkdownRenderOptions {
	/**
	 * Resolves a link destination to a navigable href or `null`. Defaults to
	 * {@link safeMarkdownHref}; hosts extend it (e.g. to allow same-origin
	 * routes) while keeping the https-only rule for everything else.
	 */
	link?: (href: string) => string | null;
	/** Accessible label for the code-block copy button. */
	copyLabel?: string;
	/** Class prefix for generated elements. Defaults to `tedix-md`. */
	classPrefix?: string;
	/** Attribute set on a link that leaves the host (default target=_blank). */
	externalTarget?: "_blank" | "_self";
}

interface ListItem {
	content: string;
	checked?: boolean;
	children: string;
}

interface InlineRenderer {
	(text: string): string;
}

const CODE_SPAN_PATTERN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

function renderInlineText(
	source: string,
	options: Required<
		Pick<MarkdownRenderOptions, "link" | "classPrefix" | "externalTarget">
	>,
): string {
	// Code spans are lifted out first so their contents stay verbatim.
	const codeSpans: string[] = [];
	const withPlaceholders = source.replace(
		CODE_SPAN_PATTERN,
		(_match, _fence: string, code: string) => {
			codeSpans.push(`<code>${escapeHtml(code.trim())}</code>`);
			return `\uE000${codeSpans.length - 1}\uE000`;
		},
	);
	// Generated anchor tags are parked here for the same reason code spans are:
	// the emphasis passes must not see their attributes.
	const parkedTags: string[] = [];
	let html = escapeHtml(withPlaceholders);
	// Images never load remote content; the alt text is kept as plain text.
	html = html.replace(
		/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^&]*&quot;)?\)/g,
		"$1",
	);
	// [text](href "title")
	html = html.replace(
		/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})(?:\s+&quot;[^&]*&quot;)?\)/g,
		(match: string, text: string, rawHref: string) => {
			const href = options.link(decodeEscapedHref(rawHref));
			if (!href) return match;
			return anchor(href, text, options, parkedTags);
		},
	);
	// Bare https autolinks.
	html = html.replace(
		/(^|[\s(])((?:https:\/\/)[^\s<]+[^\s<.,;:!?)\]'"])/g,
		(match: string, lead: string, rawHref: string) => {
			const href = options.link(decodeEscapedHref(rawHref));
			if (!href) return match;
			return `${lead}${anchor(href, rawHref, options, parkedTags, { parkText: true })}`;
		},
	);
	html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
	html = html.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>");
	html = html.replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, "$1<em>$2</em>");
	html = html.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
	// Hard line breaks inside a paragraph.
	html = html.replace(/ {2,}\n|\\\n/g, "<br>");
	html = html.replace(
		/\uE001(\d+)\uE001/g,
		(_match, index: string) => parkedTags[Number(index)] ?? "",
	);
	return html.replace(
		/\uE000(\d+)\uE000/g,
		(_match, index: string) => codeSpans[Number(index)] ?? "",
	);
}

function decodeEscapedHref(value: string): string {
	// `&amp;` is decoded last so `&amp;quot;` stays the literal text `&quot;`.
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

/**
 * Build an anchor whose OPENING TAG is parked behind a placeholder.
 *
 * The emphasis passes below run over the whole string after links are
 * generated, and they have no idea they are inside an attribute. A URL
 * carrying `__` or `_x_` — `src/__init__.py`, `__tests__`, `__pycache__` —
 * had its href rewritten to `src/<strong>init</strong>.py`, and because
 * `target="_blank"` also contains an underscore, two anchors on one line could
 * splice emphasis across the first anchor's target into the second one's href.
 * The result was a live link pointing somewhere the author never wrote.
 *
 * For a `[text](href)` link the `innerHtml` stays OUTSIDE the placeholder on
 * purpose: emphasis inside link TEXT is legitimate markdown and must keep
 * working. For a BARE autolink the visible text is the URL itself, so it is
 * parked too — otherwise the href is repaired while the label still reads
 * `https://e.com/src/<strong>init</strong>.py`, and the link displays a
 * different destination from the one it navigates to.
 */
function anchor(
	href: string,
	innerHtml: string,
	options: Required<
		Pick<MarkdownRenderOptions, "classPrefix" | "externalTarget">
	>,
	parkedTags: string[],
	{ parkText = false }: { parkText?: boolean } = {},
): string {
	const external = /^https?:/i.test(href);
	const target = external ? ` target="${options.externalTarget}"` : "";
	const open = `<a class="${options.classPrefix}-link" href="${escapeHtml(href)}" rel="noopener noreferrer"${target}>`;
	if (parkText) {
		parkedTags.push(`${open}${innerHtml}</a>`);
		return `\uE001${parkedTags.length - 1}\uE001`;
	}
	parkedTags.push(open);
	return `\uE001${parkedTags.length - 1}\uE001${innerHtml}</a>`;
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replaceAll("\\|", "|"));
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Renders trusted-shape Markdown from an untrusted author into safe HTML. */
export function renderMarkdown(
	value: unknown,
	rawOptions: MarkdownRenderOptions = {},
): string {
	const options = {
		link: rawOptions.link ?? safeMarkdownHref,
		classPrefix: rawOptions.classPrefix ?? "tedix-md",
		externalTarget: rawOptions.externalTarget ?? "_blank",
	};
	const copyLabel = rawOptions.copyLabel ?? "Copy code";
	const inline: InlineRenderer = (text) => renderInlineText(text, options);
	const lines = stripBidiControls(String(value ?? ""))
		.replace(/\r\n?/g, "\n")
		.split("\n");
	return renderBlocks(lines, inline, options.classPrefix, copyLabel);
}

function renderBlocks(
	lines: string[],
	inline: InlineRenderer,
	prefix: string,
	copyLabel: string,
): string {
	const blocks: string[] = [];
	let paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) blocks.push(`<p>${inline(paragraph.join("\n"))}</p>`);
		paragraph = [];
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const next = lines[index + 1] ?? "";

		const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
		if (fence) {
			flushParagraph();
			const marker = fence[1]!;
			const language = fence[2] ?? "";
			const code: string[] = [];
			index += 1;
			while (
				index < lines.length &&
				!new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(
					lines[index] ?? "",
				)
			) {
				code.push(lines[index] ?? "");
				index += 1;
			}
			blocks.push(codeBlock(code.join("\n"), language, prefix, copyLabel));
			continue;
		}

		if (line.includes("|") && TABLE_DIVIDER.test(next) && next.includes("|")) {
			flushParagraph();
			const headings = tableCells(line);
			const alignments = tableCells(next).map((cell) =>
				cell.startsWith(":") && cell.endsWith(":")
					? "center"
					: cell.endsWith(":")
						? "right"
						: null,
			);
			const rows: string[][] = [];
			index += 2;
			while (
				index < lines.length &&
				(lines[index] ?? "").includes("|") &&
				(lines[index] ?? "").trim()
			) {
				rows.push(tableCells(lines[index] ?? ""));
				index += 1;
			}
			index -= 1;
			const align = (cellIndex: number) =>
				alignments[cellIndex]
					? ` style="text-align:${alignments[cellIndex]}"`
					: "";
			blocks.push(
				`<div class="tedix-markdown-table" tabindex="0"><table><thead><tr>${headings
					.map(
						(cell, cellIndex) =>
							`<th scope="col"${align(cellIndex)}>${inline(cell)}</th>`,
					)
					.join("")}</tr></thead><tbody>${rows
					.map(
						(row) =>
							`<tr>${headings
								.map(
									(_, cellIndex) =>
										`<td${align(cellIndex)}>${inline(row[cellIndex] ?? "")}</td>`,
								)
								.join("")}</tr>`,
					)
					.join("")}</tbody></table></div>`,
			);
			continue;
		}

		const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			flushParagraph();
			const level = Math.min(heading[1]!.length, 6);
			blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
			continue;
		}

		if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushParagraph();
			blocks.push("<hr>");
			continue;
		}

		if (/^\s{0,3}>/.test(line)) {
			flushParagraph();
			const quoted: string[] = [];
			while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? "")) {
				quoted.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
				index += 1;
			}
			index -= 1;
			blocks.push(
				`<blockquote>${renderBlocks(quoted, inline, prefix, copyLabel)}</blockquote>`,
			);
			continue;
		}

		const listStart = listItemMatch(line);
		if (listStart) {
			flushParagraph();
			const kind = listStart.kind;
			const items: ListItem[] = [];
			const start = listStart.start;
			while (index < lines.length) {
				const current = lines[index] ?? "";
				const item = listItemMatch(current);
				if (!item || item.kind !== kind || item.indent !== listStart.indent)
					break;
				const nested: string[] = [];
				index += 1;
				while (index < lines.length) {
					const candidate = lines[index] ?? "";
					const candidateIndent = /^(\s*)/.exec(candidate)?.[1]?.length ?? 0;
					const sibling = listItemMatch(candidate);
					if (!candidate.trim()) {
						const after = lines[index + 1] ?? "";
						const afterIndent = /^(\s*)/.exec(after)?.[1]?.length ?? 0;
						if (after.trim() && afterIndent > listStart.indent) {
							nested.push("");
							index += 1;
							continue;
						}
						break;
					}
					if (sibling && sibling.indent === listStart.indent) break;
					if (candidateIndent <= listStart.indent) break;
					nested.push(
						candidate.slice(Math.min(candidateIndent, item.contentIndent)),
					);
					index += 1;
				}
				items.push({
					content: inline(item.content),
					...(item.checked === undefined ? {} : { checked: item.checked }),
					children: nested.length
						? renderBlocks(nested, inline, prefix, copyLabel)
						: "",
				});
			}
			index -= 1;
			const tag = kind;
			const startAttribute =
				tag === "ol" && start !== 1 ? ` start="${start}"` : "";
			blocks.push(
				`<${tag}${startAttribute}>${items
					.map((item) => {
						const body = `${item.content}${item.children}`;
						return item.checked === undefined
							? `<li>${body}</li>`
							: `<li class="tedix-task-item"><input type="checkbox" disabled${item.checked ? " checked" : ""}>${body}</li>`;
					})
					.join("")}</${tag}>`,
			);
			continue;
		}

		if (!line.trim()) {
			flushParagraph();
			continue;
		}
		paragraph.push(line);
	}
	flushParagraph();
	return blocks.join("");
}

function listItemMatch(line: string): {
	kind: "ol" | "ul";
	indent: number;
	contentIndent: number;
	content: string;
	start: number;
	checked?: boolean;
} | null {
	const match = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line);
	if (!match) return null;
	const indent = match[1]!.length;
	const markerWidth = match[2] ? 1 : match[3]!.length + 1;
	const contentIndent = indent + markerWidth + 1;
	const raw = match[4] ?? "";
	const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
	return {
		kind: match[2] ? "ul" : "ol",
		indent,
		contentIndent,
		content: task ? task[2]! : raw,
		start: match[3] ? Number(match[3]) : 1,
		...(task ? { checked: task[1]!.toLowerCase() === "x" } : {}),
	};
}

function codeBlock(
	code: string,
	language: string,
	prefix: string,
	copyLabel: string,
): string {
	const safeLanguage = language.replace(/[^\w+#.-]/g, "").toLowerCase();
	const languageAttribute = safeLanguage
		? ` class="language-${escapeHtml(safeLanguage)}" data-language="${escapeHtml(safeLanguage)}"`
		: "";
	const label = safeLanguage
		? `<span class="${prefix}-code-language">${escapeHtml(safeLanguage)}</span>`
		: "";
	return `<div class="${prefix}-code" data-md-code${safeLanguage ? ` data-language="${escapeHtml(safeLanguage)}"` : ""}><div class="${prefix}-code-bar">${label}<button class="${prefix}-copy" type="button" data-md-copy aria-label="${escapeHtml(copyLabel)}" title="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</button></div><pre><code${languageAttribute}>${escapeHtml(code)}</code></pre></div>`;
}

/**
 * Binds a delegated click handler for every `[data-md-copy]` button under
 * `root`. The host owns clipboard permissions; the renderer only marks the
 * affordance. Returns a disposer.
 */
export function bindMarkdownCopyButtons(
	root: {
		addEventListener: EventTarget["addEventListener"];
		removeEventListener: EventTarget["removeEventListener"];
	},
	options: {
		copiedLabel?: string;
		resetAfterMs?: number;
		write?: (text: string) => Promise<void>;
	} = {},
): () => void {
	const write =
		options.write ??
		((text: string) =>
			globalThis.navigator?.clipboard?.writeText(text) ??
			Promise.reject(new Error("Clipboard unavailable")));
	const handler = (event: Event) => {
		const target = event.target as {
			closest?: (selector: string) => Element | null;
		} | null;
		const button = target?.closest?.(
			"[data-md-copy]",
		) as HTMLButtonElement | null;
		if (!button) return;
		const code = button.closest("[data-md-code]")?.querySelector("pre code");
		const text = code?.textContent ?? "";
		const original = button.textContent;
		void write(text)
			.then(() => {
				button.textContent = options.copiedLabel ?? "Copied";
				button.dataset.copied = "true";
			})
			.catch(() => {
				button.dataset.copied = "false";
			})
			.finally(() => {
				setTimeout(() => {
					button.textContent = original;
					delete button.dataset.copied;
				}, options.resetAfterMs ?? 1600);
			});
	};
	root.addEventListener("click", handler);
	return () => root.removeEventListener("click", handler);
}
