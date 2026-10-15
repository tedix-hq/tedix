/**
 * Print-friendly HTML rendering for Tedix OS output exports.
 *
 * The produced document is handed verbatim to Cloudflare Browser Rendering
 * (`pdf` / `screenshot` quick actions). Remote resources are restricted by
 * OS_EXPORT_REQUEST_PATTERNS, including redirect requests. Every piece of
 * user text flows through `escapeHtml` before it reaches the markup.
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

// Keep the browser network boundary narrower than arbitrary tenant image URLs.
const OS_EXPORT_REQUEST_PATTERNS = [
	"^https://tedix\\.dev/_emdash/api/media/file/[A-Za-z0-9_-]+\\.(?:png|jpe?g|gif|webp)$",
	"^https://fonts\\.googleapis\\.com/css2\\?",
	"^https://fonts\\.gstatic\\.com/s/[A-Za-z0-9/_.-]+$",
	"^data:image/(?:png|jpeg|gif|webp);",
];

export const OS_EXPORT_RESOURCE_WAIT = {
	allowRequestPattern: OS_EXPORT_REQUEST_PATTERNS,
	addScriptTag: [
		{
			content: `(async () => {
  if (document.readyState !== "complete") await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  document.body.getBoundingClientRect();
  await Promise.all([
    document.fonts.ready.then(() => {
      if ([...document.fonts].some(font => font.status === "error")) throw new Error("Export font failed");
    }),
    ...Array.from(document.images, image => image.decode())
  ]);
  document.documentElement.dataset.exportReady = "true";
})().catch(() => {});`,
		},
	],
	waitForSelector: {
		selector: 'html[data-export-ready="true"]',
		timeout: 20_000,
	},
};

function isExportImage(source: string): boolean {
	return (
		/^data:image\/(?:png|jpeg|gif|webp);/i.test(source) ||
		new RegExp(OS_EXPORT_REQUEST_PATTERNS[0]!).test(source)
	);
}

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
			if (!isExportImage(source)) return "";
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

function renderSlide(slide: OsPresentationSlide): string {
	const bullets =
		slide.bullets.length > 0
			? `<ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
			: "";
	return `<section class="slide"><h2>${escapeHtml(slide.title)}</h2>${bullets}</section>`;
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
		// Same rule as `presentationLineHeight` in apps/os: display type sets
		// tight, body copy opens up. Change both together.
		`line-height:${(style.fontSize ?? 24) >= 40 ? 1.1 : 1.3}`,
		style.fontFamily && /^[a-zA-Z0-9 ,'-]+$/.test(style.fontFamily)
			? `font-family:${escapeHtml(style.fontFamily)}`
			: "",
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
		"white-space:pre-wrap",
		"overflow-wrap:break-word",
		"overflow:hidden",
	]
		.filter(Boolean)
		.join(";");
	const source = element.src ?? "";
	const body =
		(element.type === "image" || element.type === "svg") &&
		isExportImage(source)
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
			(slide) =>
				`<section class="canvas-slide" style="background:${safeCssColor(slide.background) ?? "#ffffff"}">${slide.elements.map(renderDeckElement).join("")}</section>`,
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
	@page { margin: 1.5cm; }
`;

// Match the authored canvas rather than fitting a slide into a document page.
const PRESENTATION_CSS = `
	@page { size: 1200px 675px; margin: 0; }
	html, body { width: 1200px; margin: 0; padding: 0; line-height: 1.5; }
	section.slide, section.canvas-slide { width: 1200px; height: 675px; min-height: 0; border: 0; overflow: hidden; break-inside: avoid; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
	section.slide { padding: 60px 70px; font-size: 28px; }
	section.slide h2 { font-size: 44px; }
`;

/**
 * Render an output's revision content as one HTML document
 * string — semantic structure per kind (document → article of blocks, sheet →
 * table, presentation → page-broken sections), with allowlisted resources and
 * every user string HTML-escaped.
 */
export function renderOsOutputHtml(
	output: Pick<OsOutput, "kind" | "title">,
	revision: Pick<OsOutputRevision, "revision" | "content" | "createdAt">,
): string {
	const title = escapeHtml(output.title);
	const body = renderBody(revision.content);
	const fontFamilies = ["DM Sans", "Space Grotesk", "Raleway"].filter(
		(family) => body.includes(`font-family:${family}`),
	);
	const fontStylesheet = fontFamilies.length
		? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fontFamilies.map((family) => `family=${family.replaceAll(" ", "+")}:wght@400;500;600;700`).join("&amp;")}&amp;display=block">`
		: "";
	const isPresentation = revision.content.kind === "presentation";
	const meta = escapeHtml(
		`${output.kind} — revision ${revision.revision} — ${revision.createdAt}`,
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
${fontStylesheet}
<style>${INLINE_CSS}${isPresentation ? PRESENTATION_CSS : ""}</style>
</head>
<body>
${isPresentation ? "" : `<header class="export-header"><h1>${title}</h1><p class="meta">${meta}</p></header>`}
${body}
</body>
</html>`;
}
