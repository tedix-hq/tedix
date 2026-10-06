/**
 * Self-contained, print-friendly HTML rendering for Tedix OS output exports.
 *
 * The produced document is handed verbatim to Cloudflare Browser Rendering
 * (`pdf` / `screenshot` quick actions), so it must never trigger an external
 * request: all CSS is inline and every piece of user text flows through
 * `escapeHtml` before it reaches the markup.
 */

import type {
	OsDocumentBlock,
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
	OsPresentationElement,
	OsPresentationSlide,
	OsRichTextNode,
	OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(character) => HTML_ESCAPES[character] ?? character,
	);
}

function renderDocumentBlock(block: OsDocumentBlock): string {
	switch (block.type) {
		case "heading":
			return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
		case "paragraph":
			return `<p>${escapeHtml(block.text)}</p>`;
		case "list": {
			const tag = block.ordered ? "ol" : "ul";
			const items = block.items
				.map((item) => `<li>${escapeHtml(item)}</li>`)
				.join("");
			return `<${tag}>${items}</${tag}>`;
		}
		case "code": {
			const language = block.language
				? ` data-language="${escapeHtml(block.language)}"`
				: "";
			return `<pre><code${language}>${escapeHtml(block.text)}</code></pre>`;
		}
		case "quote":
			return `<blockquote><p>${escapeHtml(block.text)}</p></blockquote>`;
	}
}

function safeCssColor(value: string | undefined): string | undefined {
	return value && /^(?:#[0-9a-f]{3,8}|rgba?\([0-9.,% ]+\))$/i.test(value)
		? value
		: undefined;
}

function renderRichTextNode(node: OsRichTextNode): string {
	if (node.type === "text") {
		let value = escapeHtml(node.text ?? "");
		for (const mark of node.marks ?? []) {
			switch (mark.type) {
				case "bold":
					value = `<strong>${value}</strong>`;
					break;
				case "italic":
					value = `<em>${value}</em>`;
					break;
				case "underline":
					value = `<u>${value}</u>`;
					break;
				case "strike":
					value = `<s>${value}</s>`;
					break;
				case "code":
					value = `<code>${value}</code>`;
					break;
				case "highlight": {
					const color = safeCssColor(
						typeof mark.attrs?.color === "string"
							? mark.attrs.color
							: undefined,
					);
					value = color
						? `<mark style="background:${color}">${value}</mark>`
						: `<mark>${value}</mark>`;
					break;
				}
				case "link": {
					const href = mark.attrs?.href;
					if (typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href))
						value = `<a href="${escapeHtml(href)}">${value}</a>`;
					break;
				}
				case "textStyle": {
					const color = safeCssColor(
						typeof mark.attrs?.color === "string"
							? mark.attrs.color
							: undefined,
					);
					const size = mark.attrs?.fontSize;
					const family = mark.attrs?.fontFamily;
					const styles = [
						color ? `color:${color}` : "",
						typeof size === "string" && /^\d+(?:\.\d+)?px$/.test(size)
							? `font-size:${size}`
							: "",
						typeof family === "string" && /^[a-zA-Z0-9 ,'-]+$/.test(family)
							? `font-family:${escapeHtml(family)}`
							: "",
					].filter(Boolean);
					if (styles.length)
						value = `<span style="${styles.join(";")}">${value}</span>`;
					break;
				}
			}
		}
		return value;
	}
	const children = (node.content ?? []).map(renderRichTextNode).join("");
	const alignment = ["left", "center", "right", "justify"].includes(
		String(node.attrs?.textAlign),
	)
		? ` style="text-align:${String(node.attrs?.textAlign)}"`
		: "";
	switch (node.type) {
		case "heading": {
			const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 2));
			return `<h${level}${alignment}>${children}</h${level}>`;
		}
		case "paragraph":
			return `<p${alignment}>${children}</p>`;
		case "bulletList":
			return `<ul>${children}</ul>`;
		case "orderedList":
			return `<ol>${children}</ol>`;
		case "listItem":
			return `<li>${children}</li>`;
		case "blockquote":
			return `<blockquote>${children}</blockquote>`;
		case "codeBlock":
			return `<pre><code>${children}</code></pre>`;
		case "horizontalRule":
			return "<hr>";
		case "image": {
			const source = typeof node.attrs?.src === "string" ? node.attrs.src : "";
			if (!/^data:image\/(?:png|jpeg|gif|webp);/i.test(source)) return "";
			const alt =
				typeof node.attrs?.alt === "string" ? node.attrs.alt : "Document image";
			const dimensions = ["width", "height"]
				.map((key) => {
					const value = node.attrs?.[key];
					return typeof value === "number" &&
						Number.isFinite(value) &&
						value > 0
						? ` ${key}="${value}"`
						: "";
				})
				.join("");
			return `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${dimensions}>`;
		}
		default:
			return children;
	}
}

function renderSheetCell(cell: OsSheetCell): string {
	if (cell === null) return "<td></td>";
	if (typeof cell === "number") {
		return `<td class="num">${escapeHtml(String(cell))}</td>`;
	}
	return `<td>${escapeHtml(String(cell))}</td>`;
}

function renderSlide(slide: OsPresentationSlide, index: number): string {
	const bullets =
		slide.bullets.length > 0
			? `<ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
			: "";
	const notes = slide.notes
		? `<aside class="notes">${escapeHtml(slide.notes)}</aside>`
		: "";
	return `<section class="slide"><p class="slide-number">${index + 1}</p><h2>${escapeHtml(slide.title)}</h2>${bullets}${notes}</section>`;
}

function renderWorkbook(
	content: Extract<OsOutputContent, { kind: "sheet" }>,
): string {
	if (!content.workbook) {
		const head = content.columns
			.map((column) => `<th>${escapeHtml(column)}</th>`)
			.join("");
		const body = content.rows
			.map(
				(row) =>
					`<tr>${content.columns.map((_, index) => renderSheetCell(row[index] ?? null)).join("")}</tr>`,
			)
			.join("");
		return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
	}
	return content.workbook.sheets
		.map((sheet) => {
			const head = sheet.columns
				.map((column) => `<th>${escapeHtml(column.label)}</th>`)
				.join("");
			const rows = sheet.rows
				.map(
					(row) =>
						`<tr>${sheet.columns
							.map((_, index) => {
								const cell = row[index];
								const value = cell?.value ?? null;
								const format = cell?.format;
								const declarations = [
									format?.bold ? "font-weight:700" : "",
									format?.italic ? "font-style:italic" : "",
									format?.underline ? "text-decoration:underline" : "",
									format?.horizontalAlign
										? `text-align:${format.horizontalAlign}`
										: "",
									safeCssColor(format?.fillColor)
										? `background:${safeCssColor(format?.fillColor)}`
										: "",
									safeCssColor(format?.textColor)
										? `color:${safeCssColor(format?.textColor)}`
										: "",
								]
									.filter(Boolean)
									.join(";");
								const className =
									typeof value === "number" ? ' class="num"' : "";
								return `<td${className}${declarations ? ` style="${declarations}"` : ""}>${escapeHtml(value === null ? "" : String(value))}</td>`;
							})
							.join("")}</tr>`,
				)
				.join("");
			return `<section class="sheet"><h2>${escapeHtml(sheet.name)}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
		})
		.join("");
}

function renderDeckElement(element: OsPresentationElement): string {
	const style = element.style;
	const declarations = [
		"position:absolute",
		`left:${element.x}px`,
		`top:${element.y}px`,
		`width:${element.width}px`,
		`height:${element.height}px`,
		`font-size:${style.fontSize ?? 24}px`,
		style.fontWeight
			? `font-weight:${style.fontWeight === "semibold" ? 600 : style.fontWeight === "medium" ? 500 : style.fontWeight}`
			: "",
		safeCssColor(style.color) ? `color:${safeCssColor(style.color)}` : "",
		safeCssColor(style.background)
			? `background:${safeCssColor(style.background)}`
			: "",
		safeCssColor(style.borderColor)
			? `border-color:${safeCssColor(style.borderColor)}`
			: "",
		style.borderWidth
			? `border-style:solid;border-width:${style.borderWidth}px`
			: "",
		style.borderRadius ? `border-radius:${style.borderRadius}px` : "",
		style.textAlign ? `text-align:${style.textAlign}` : "",
		style.opacity !== undefined ? `opacity:${style.opacity}` : "",
		style.rotation ? `transform:rotate(${style.rotation}deg)` : "",
		"white-space:pre-line",
		"overflow:hidden",
	]
		.filter(Boolean)
		.join(";");
	const source = element.src ?? "";
	const body =
		(element.type === "image" || element.type === "svg") &&
		/^data:image\/(?:png|jpeg|gif|webp);/i.test(source)
			? `<img src="${escapeHtml(source)}" alt="${escapeHtml(element.text ?? "Slide image")}">`
			: escapeHtml(element.text ?? "");
	return `<div style="${declarations}">${body}</div>`;
}

function renderDeck(
	content: Extract<OsOutputContent, { kind: "presentation" }>,
): string {
	if (!content.deck) return content.slides.map(renderSlide).join("");
	return content.deck.slides
		.map(
			(slide, index) =>
				`<section class="canvas-slide" style="background:${safeCssColor(slide.background) ?? "#ffffff"}"><p class="slide-number">${index + 1}</p>${slide.elements.map(renderDeckElement).join("")}${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}</section>`,
		)
		.join("");
}

function renderBody(content: OsOutputContent): string {
	switch (content.kind) {
		case "document":
			return `<article>${content.richText ? content.richText.content.map(renderRichTextNode).join("") : content.blocks.map(renderDocumentBlock).join("")}</article>`;
		case "sheet":
			return renderWorkbook(content);
		case "presentation":
			return renderDeck(content);
		case "video":
			return `<article><p>${escapeHtml(content.caption ?? "MP4 video output")}</p><p>Render ${escapeHtml(content.renderId)}</p></article>`;
	}
}

const INLINE_CSS = `
	:root { color-scheme: light; }
	* { box-sizing: border-box; }
	body { margin: 0; padding: 2rem 2.5rem; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #ffffff; line-height: 1.55; }
	header.export-header { border-bottom: 2px solid #1a1a1a; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
	header.export-header h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
	header.export-header .meta { margin: 0; font-size: 0.8rem; color: #555555; }
	article h1, article h2, article h3, article h4 { margin: 1.4em 0 0.5em; line-height: 1.25; }
	article p { margin: 0.6em 0; }
	blockquote { margin: 0.8em 0; padding: 0.2em 1em; border-left: 3px solid #999999; color: #444444; }
	pre { background: #f4f4f4; border: 1px solid #dddddd; border-radius: 4px; padding: 0.8em 1em; overflow-x: auto; page-break-inside: avoid; }
	code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; white-space: pre-wrap; word-break: break-word; }
	table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
	th, td { border: 1px solid #cccccc; padding: 0.35em 0.6em; text-align: left; vertical-align: top; }
	th { background: #f0f0f0; }
	td.num { text-align: right; font-variant-numeric: tabular-nums; }
	tr { page-break-inside: avoid; }
	section.slide { page-break-after: always; break-after: page; padding: 1.5rem 0; min-height: 60vh; border-bottom: 1px solid #dddddd; }
	section.slide:last-of-type { page-break-after: auto; break-after: auto; border-bottom: none; }
	section.sheet { page-break-after: always; break-after: page; }
	section.sheet:last-of-type { page-break-after: auto; break-after: auto; }
	section.canvas-slide { position: relative; width: 1200px; height: 675px; overflow: hidden; page-break-after: always; break-after: page; transform-origin: top left; }
	section.canvas-slide:last-of-type { page-break-after: auto; break-after: auto; }
	section.canvas-slide img { width: 100%; height: 100%; object-fit: contain; max-width: 100%; }
	article img { max-width: 100%; height: auto; object-fit: contain; }
	article h1 { font-size:26px; font-weight:600; }
	article h2 { font-size:21px; font-weight:600; }
	article h3 { font-size:17px; font-weight:600; }
	article a { color:#1267c4; text-decoration:underline; }
	section.slide h2 { margin: 0 0 0.75rem; font-size: 1.4rem; }
	section.slide .slide-number { margin: 0; font-size: 0.75rem; color: #888888; }
	aside.notes { margin-top: 1rem; padding: 0.6em 0.9em; background: #f7f7f7; border: 1px dashed #cccccc; font-size: 0.8rem; color: #555555; }
	@page { margin: 1.5cm; }
`;

/**
 * Render an output's revision content as one self-contained HTML document
 * string — semantic structure per kind (document → article of blocks, sheet →
 * table, presentation → page-broken sections), inline CSS only, no external
 * requests, every user string HTML-escaped.
 */
export function renderOsOutputHtml(
	output: Pick<OsOutput, "kind" | "title">,
	revision: Pick<OsOutputRevision, "revision" | "content" | "createdAt">,
): string {
	const title = escapeHtml(output.title);
	const meta = escapeHtml(
		`${output.kind} — revision ${revision.revision} — ${revision.createdAt}`,
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<header class="export-header"><h1>${title}</h1><p class="meta">${meta}</p></header>
${renderBody(revision.content)}
</body>
</html>`;
}
