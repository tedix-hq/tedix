import { richTextFromBlocks } from "@tedix/api-contract/utils/os-document";
/**
 * Print-friendly HTML rendering for Tedix OS output exports.
 *
 * The produced document is handed verbatim to Cloudflare Browser Rendering
 * (`pdf` / `screenshot` quick actions). Remote resources are restricted by
 * OS_EXPORT_REQUEST_PATTERNS, including redirect requests. Every piece of
 * user text flows through `escapeHtml` before it reaches the markup.
 */

import { formatWorkbookNumber } from "@tedix/api-contract/utils/workbook-number-format";
import {
	parseSlideText,
	slideElementMarkup,
	slideBackgroundMarkup,
	slideCss,
	type PresentationAppearance,
	slideElementStyle,
} from "@tedix/api-contract/utils/presentation-style";
import type {
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
	OsPresentationElement,
	OsPresentationSlide,
	OsPresentationTheme,
	OsRichTextNode,
	OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";

// Keep the browser network boundary narrower than arbitrary tenant image URLs.
const OS_EXPORT_REQUEST_PATTERNS = [
	"^https://tedix\\.dev/_emdash/api/media/file/[A-Za-z0-9_-]+\\.(?:png|jpe?g|gif|webp)$",
	"^https://fonts\\.googleapis\\.com/css2\\?",
	"^https://fonts\\.gstatic\\.com/s/[A-Za-z0-9/_.-]+$",
	"^data:image/(?:png|jpeg|gif|webp|svg\\+xml);",
];

export const OS_EXPORT_RESOURCE_WAIT = {
	allowRequestPattern: OS_EXPORT_REQUEST_PATTERNS,
	addScriptTag: [
		{
			content: `(async () => {
  if (document.readyState !== "complete") await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  await Promise.all(Array.from(document.querySelectorAll("link[data-export-font-fallback]"), link => {
    if (link.sheet) return;
    return new Promise(resolve => {
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
      link.href = link.dataset.exportFontFallback;
    });
  }));
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
		/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(source) ||
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

function safeCssColor(value: string | undefined): string | undefined {
	return value && /^(?:#[0-9a-f]{3,8}|rgba?\([0-9.,% ]+\))$/i.test(value)
		? value
		: undefined;
}

export function renderRichTextNode(node: OsRichTextNode): string {
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
						typeof family === "string" && /^[a-zA-Z0-9 ,'"-]+$/.test(family)
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
	const indent = Math.min(8, Math.trunc(Number(node.attrs?.indent) || 0));
	const blockStyles = [
		["left", "center", "right", "justify"].includes(
			String(node.attrs?.textAlign),
		)
			? `text-align:${String(node.attrs?.textAlign)}`
			: "",
		indent > 0 ? `margin-left:${indent * 40}px` : "",
	].filter(Boolean);
	const alignment = blockStyles.length
		? ` style="${blockStyles.join(";")}"`
		: "";
	switch (node.type) {
		case "heading": {
			const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 2));
			const title =
				level === 1 && node.attrs?.variant === "title"
					? ' class="doc-title"'
					: "";
			return `<h${level}${title}${alignment}>${children}</h${level}>`;
		}
		case "table":
			return `<table style="border-collapse:collapse;width:100%"><tbody>${children}</tbody></table>`;
		case "tableRow":
			return `<tr>${children}</tr>`;
		case "tableHeader":
		case "tableCell": {
			const tag = node.type === "tableHeader" ? "th" : "td";
			const width = Array.isArray(node.attrs?.colwidth)
				? Number(node.attrs.colwidth[0])
				: 0;
			const colspan = Math.max(
				1,
				Math.min(64, Number(node.attrs?.colspan) || 1),
			);
			const rowspan = Math.max(
				1,
				Math.min(1000, Number(node.attrs?.rowspan) || 1),
			);
			return `<${tag} colspan="${colspan}" rowspan="${rowspan}" style="border:1px solid #888;padding:8px;vertical-align:top;${width >= 40 && width <= 2000 ? `width:${width}px;` : ""}${tag === "th" ? "background:#eee;" : ""}">${children}</${tag}>`;
		}
		case "callout":
			return `<aside style="border-left:4px solid #888;padding:12px">${children}</aside>`;
		case "details":
			return `<details open>${children}</details>`;
		case "detailsSummary":
			return `<summary>${children}</summary>`;
		case "detailsContent":
			return `<div>${children}</div>`;
		case "taskList":
			return `<ul style="list-style:none">${children}</ul>`;
		case "taskItem":
			return `<li>${node.attrs?.checked === true ? "☑" : "☐"} ${children}</li>`;
		case "paragraph":
			return `<p${alignment}>${children}</p>`;
		case "bulletList":
			return `<ul>${children}</ul>`;
		case "orderedList": {
			const start = Number(node.attrs?.start);
			return `<ol${Number.isSafeInteger(start) && start > 0 ? ` start="${start}"` : ""}>${children}</ol>`;
		}
		case "listItem":
			return `<li>${children}</li>`;
		case "blockquote":
			return `<blockquote>${children}</blockquote>`;
		case "codeBlock":
			return `<pre${alignment}><code${typeof node.attrs?.language === "string" && node.attrs.language ? ` data-language="${escapeHtml(node.attrs.language)}"` : ""}>${children}</code></pre>`;
		case "horizontalRule":
			return "<hr>";
		case "hardBreak":
			return "<br>";
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
								return `<td${className}${declarations ? ` style="${declarations}"` : ""}>${escapeHtml(formatWorkbookNumber(cell ?? null, content.workbook))}</td>`;
							})
							.join("")}</tr>`,
				)
				.join("");
			return `<section class="sheet"><h2>${escapeHtml(sheet.name)}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
		})
		.join("");
}

function renderDeckElement(
	element: OsPresentationElement,
	organization: PresentationAppearance,
	theme?: OsPresentationTheme,
): string {
	const source = element.src;
	const safe =
		source && !isExportImage(source) ? { ...element, src: undefined } : element;
	const declarations = slideCss({
		position: "absolute",
		...slideElementStyle(element, "pixels", organization, theme),
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
		overflow: "hidden",
	});
	return `<div style="${declarations}">${slideElementMarkup(safe, "pixels", organization)}</div>`;
}

function renderDeck(
	content: Extract<OsOutputContent, { kind: "presentation" }>,
	organization: PresentationAppearance,
): string {
	if (!content.deck) return content.slides.map(renderSlide).join("");
	const safeOrganization = {
		...organization,
		logoUrl:
			organization.logoUrl && isExportImage(organization.logoUrl)
				? organization.logoUrl
				: undefined,
	};
	return content.deck.slides
		.map(
			(slide) =>
				`<section class="canvas-slide" style="${slideCss({ background: slide.background })}">${slideBackgroundMarkup({ ...slide, backgroundImage: slide.backgroundImage && isExportImage(slide.backgroundImage) ? slide.backgroundImage : undefined }, "pixels", safeOrganization)}${slide.elements.map((element) => renderDeckElement(element, safeOrganization, content.deck!.theme)).join("")}</section>`,
		)
		.join("");
}

function renderBody(
	content: OsOutputContent,
	organization: PresentationAppearance,
): string {
	switch (content.kind) {
		case "document":
			return `<article>${(content.richText ?? richTextFromBlocks(content.blocks)).content.map(renderRichTextNode).join("")}</article>`;
		case "sheet":
			return renderWorkbook(content);
		case "presentation":
			return renderDeck(content, organization);
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
	article h1.doc-title { font-size:30px; letter-spacing:-0.02em; }
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

// Keep this in step with the viewer's slide-fonts.ts system-family exclusions.
const SYSTEM_FONTS = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-sans-serif",
	"ui-serif",
	"ui-monospace",
	"ui-rounded",
	"emoji",
	"math",
	"fangsong",
	"inherit",
	"initial",
	"unset",
	"-apple-system",
	"blinkmacsystemfont",
	"segoe ui",
	"helvetica",
	"helvetica neue",
	"arial",
	"times",
	"times new roman",
	"georgia",
	"courier",
	"courier new",
	"verdana",
	"menlo",
	"monaco",
	"consolas",
	"sf mono",
	"ft kunst grotesk",
	"apercu mono pro",
	"comfortaa variable",
]);

function collectExportFonts(content: OsOutputContent) {
	const fonts = new Map<string, { family: string; weights: Set<number> }>();
	const add = (stack: string | undefined, weight: number) => {
		for (const part of stack?.split(",") ?? []) {
			const family = part
				.trim()
				.replace(/^(['"])(.*)\1$/, "$2")
				.trim()
				.replace(/ +/g, " ");
			if (!family || SYSTEM_FONTS.has(family.toLowerCase())) continue;
			if (!/^[A-Za-z0-9 ]{1,40}$/.test(family)) return;
			const key = family.toLowerCase();
			let font = fonts.get(key);
			if (!font && fonts.size < 6) {
				font = { family, weights: new Set() };
				fonts.set(key, font);
			}
			font?.weights.add(weight);
			return;
		}
	};
	if (content.kind === "presentation") {
		// Deck theme fonts come first so they keep their slot inside the family cap.
		for (const stack of [
			content.deck?.theme?.headingFont,
			content.deck?.theme?.bodyFont,
		])
			for (const weight of [300, 400, 500, 600, 700]) add(stack, weight);
		for (const slide of content.deck?.slides ?? []) {
			for (const { style, text, props, type } of slide.elements) {
				add(
					style.fontFamily,
					{ light: 300, normal: 400, medium: 500, semibold: 600, bold: 700 }[
						style.fontWeight ?? "normal"
					],
				);
				if (type === "card" || type === "box") {
					add(style.fontFamily, 600);
					add(style.fontFamily, 400);
				}
				if (
					parseSlideText(
						[text, props?.title, props?.body, props?.eyebrow]
							.filter(Boolean)
							.join("\n"),
					).some((part) => part.bold)
				)
					add(style.fontFamily, 700);
			}
		}
	} else if (content.kind === "document") {
		const visit = (node: OsRichTextNode) => {
			for (const mark of node.marks ?? []) {
				if (
					mark.type === "textStyle" &&
					typeof mark.attrs?.fontFamily === "string"
				) {
					add(
						mark.attrs.fontFamily,
						node.marks?.some((mark) => mark.type === "bold") ? 700 : 400,
					);
				}
			}
			node.content?.forEach(visit);
		};
		content.richText?.content.forEach(visit);
	}
	return [...fonts.values()];
}

/**
 * Render an output's revision content as one HTML document
 * string — semantic structure per kind (document → article of blocks, sheet →
 * table, presentation → page-broken sections), with allowlisted resources and
 * every user string HTML-escaped.
 */
export function renderOsOutputHtml(
	output: Pick<OsOutput, "kind" | "title">,
	revision: Pick<OsOutputRevision, "revision" | "content" | "createdAt">,
	organization: PresentationAppearance = {},
): string {
	const title = escapeHtml(output.title);
	const body = renderBody(revision.content, organization);
	const fontStylesheet = collectExportFonts(revision.content)
		.map(({ family, weights }) => {
			const name = family.replaceAll(" ", "+");
			const base = `https://fonts.googleapis.com/css2?family=${name}`;
			return `<link rel="stylesheet" href="${base}:wght@${[...weights].sort((a, b) => a - b).join(";")}&amp;display=block" data-export-font-fallback="${base}&amp;display=block">`;
		})
		.join("\n");
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
