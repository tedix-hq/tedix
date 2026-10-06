/**
 * `.docx` (WordprocessingML) written straight from a document output's content
 * model.
 *
 * The document body has two shapes and they are not equivalent: `richText` is
 * the interactive Tiptap body an author actually edited, and `blocks` is its
 * stable semantic projection. The rich body is used when it is present, so
 * inline bold/italic/underline/strike/code survive the export; `blocks` is the
 * fallback for headless and agent-authored documents that never grew one.
 */

import type {
	OsDocumentBlock,
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createZip, relationships, xmlEscape, xmlPart } from "./zip";

type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;

const WORD_NS =
	"http://schemas.openxmlformats.org/wordprocessingml/2006/main" as const;
const REL_NS =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships" as const;

/** Bullet list `numId`, then the ordered one. Both defined in numbering.xml. */
const BULLET_NUM_ID = 1;
const ORDERED_NUM_ID = 2;

interface RunFormat {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	code?: boolean;
	fontSize?: number;
	fontFamily?: string;
	color?: string;
	highlight?: string;
}

function runXml(text: string, format: RunFormat = {}): string {
	if (text.length === 0) return "";
	const fontFamily = format.code ? "Consolas" : format.fontFamily;
	const properties = [
		fontFamily
			? `<w:rFonts w:ascii="${xmlEscape(fontFamily)}" w:hAnsi="${xmlEscape(fontFamily)}"/>`
			: "",
		format.bold ? "<w:b/>" : "",
		format.italic ? "<w:i/>" : "",
		format.strike ? "<w:strike/>" : "",
		format.color ? `<w:color w:val="${format.color}"/>` : "",
		format.fontSize &&
		Number.isFinite(format.fontSize) &&
		format.fontSize > 0 &&
		format.fontSize <= 512
			? `<w:sz w:val="${Math.round(format.fontSize * 1.5)}"/>`
			: "",
		format.underline ? '<w:u w:val="single"/>' : "",
		format.highlight
			? `<w:shd w:val="clear" w:fill="${format.highlight}"/>`
			: "",
	].join("");
	// A hard break inside a run is how Word keeps a multi-line value in one
	// paragraph; splitting on it keeps line structure without inventing
	// paragraphs the author never made.
	const body = text
		.split("\n")
		.map((line) => `<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
		.join("<w:br/>");
	return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${body}</w:r>`;
}

interface ParagraphOptions {
	style?: string;
	numId?: number;
	level?: number;
	alignment?: string;
}

function paragraphXml(runs: string, options: ParagraphOptions = {}): string {
	const properties = [
		options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
		options.numId
			? `<w:numPr><w:ilvl w:val="${options.level ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>`
			: "",
		options.alignment
			? `<w:jc w:val="${options.alignment === "justify" ? "both" : options.alignment}"/>`
			: "",
	].join("");
	return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${runs}</w:p>`;
}

function headingStyle(level: number): string {
	return `Heading${Math.min(Math.max(Math.trunc(level), 1), 4)}`;
}

function blockParagraphs(block: OsDocumentBlock): string[] {
	switch (block.type) {
		case "heading":
			return [
				paragraphXml(runXml(block.text), { style: headingStyle(block.level) }),
			];
		case "paragraph":
			return [paragraphXml(runXml(block.text))];
		case "quote":
			return [paragraphXml(runXml(block.text), { style: "Quote" })];
		case "code":
			return block.text
				.split("\n")
				.map((line) =>
					paragraphXml(runXml(line, { code: true }), { style: "CodeBlock" }),
				);
		case "list":
			return block.items.map((item) =>
				paragraphXml(runXml(item), {
					style: "ListParagraph",
					numId: block.ordered ? ORDERED_NUM_ID : BULLET_NUM_ID,
				}),
			);
	}
}

/** Collect the inline runs of a Tiptap node's children. */
interface DocumentAssets {
	links: Array<{ id: string; type: string; target: string; mode?: string }>;
	images: Array<{ name: string; data: Uint8Array }>;
}

function hexColor(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)
	)
		return undefined;
	const hex = value.slice(1);
	return hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
}

function wordFont(stack: string): string {
	const family = stack
		.split(",")[0]!
		.trim()
		.replace(/^["']|["']$/g, "");
	return (
		(
			{
				"ui-monospace": "Consolas",
				monospace: "Consolas",
				"sans-serif": "Calibri",
				serif: "Georgia",
			} as Record<string, string>
		)[family] ?? family
	);
}

function imageSize(
	bytes: Uint8Array,
	kind: string,
): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (kind === "png" && bytes.length >= 24)
		return { width: view.getUint32(16), height: view.getUint32(20) };
	if (kind === "gif" && bytes.length >= 10)
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (kind === "jpeg") {
		let offset = 2;
		while (offset + 8 < bytes.length && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1]!;
			const length = view.getUint16(offset + 2);
			if (
				[
					0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
					0xce, 0xcf,
				].includes(marker)
			)
				return {
					height: view.getUint16(offset + 5),
					width: view.getUint16(offset + 7),
				};
			if (length < 2) break;
			offset += 2 + length;
		}
	}
	return undefined;
}

function inlineRuns(
	nodes: OsRichTextNode[] | undefined,
	assets: DocumentAssets,
): string {
	if (!nodes) return "";
	return nodes
		.map((node) => {
			if (node.type === "hardBreak") return "<w:r><w:br/></w:r>";
			if (typeof node.text === "string") {
				const marks = new Set((node.marks ?? []).map((mark) => mark.type));
				const style = node.marks?.find(
					(mark) => mark.type === "textStyle",
				)?.attrs;
				const size =
					typeof style?.fontSize === "string" &&
					/^\d+(?:\.\d+)?px$/.test(style.fontSize)
						? Number.parseFloat(style.fontSize)
						: undefined;
				const run = runXml(node.text, {
					fontSize: size,
					fontFamily:
						typeof style?.fontFamily === "string"
							? wordFont(style.fontFamily)
							: undefined,
					color: hexColor(style?.color),
					highlight: hexColor(
						node.marks?.find((mark) => mark.type === "highlight")?.attrs?.color,
					),
					bold: marks.has("bold") || marks.has("strong"),
					italic: marks.has("italic") || marks.has("em"),
					underline: marks.has("underline"),
					strike: marks.has("strike") || marks.has("strikethrough"),
					code: marks.has("code"),
				});
				const href = node.marks?.find((mark) => mark.type === "link")?.attrs
					?.href;
				if (typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href)) {
					const id = `link${assets.links.length + 1}`;
					assets.links.push({
						id,
						type: `${REL_NS}/hyperlink`,
						target: href,
						mode: "External",
					});
					return `<w:hyperlink r:id="${id}">${run}</w:hyperlink>`;
				}
				return run;
			}
			// An unexpected inline wrapper still contributes its text.
			return inlineRuns(node.content, assets);
		})
		.join("");
}

/** Flatten a Tiptap block node into Word paragraphs. */
function richTextParagraphs(
	node: OsRichTextNode,
	assets: DocumentAssets,
	inherited: ParagraphOptions = {},
): string[] {
	const alignment = node.attrs?.textAlign;
	if (
		typeof alignment === "string" &&
		["left", "center", "right", "justify"].includes(alignment)
	)
		inherited = { ...inherited, alignment };
	switch (node.type) {
		case "heading": {
			const level = Number(node.attrs?.level ?? 1);
			return [
				paragraphXml(inlineRuns(node.content, assets), {
					...inherited,
					style: headingStyle(Number.isFinite(level) ? level : 1),
				}),
			];
		}
		case "paragraph":
			return [paragraphXml(inlineRuns(node.content, assets), inherited)];
		case "blockquote":
			return (node.content ?? []).flatMap((child) =>
				richTextParagraphs(child, assets, { ...inherited, style: "Quote" }),
			);
		case "codeBlock":
			return (node.content ?? [])
				.flatMap((child) => (child.text ?? "").split("\n"))
				.map((line) =>
					paragraphXml(runXml(line, { code: true }), { style: "CodeBlock" }),
				);
		case "bulletList":
		case "orderedList": {
			const numId =
				node.type === "orderedList" ? ORDERED_NUM_ID : BULLET_NUM_ID;
			const level = (inherited.level ?? -1) + 1;
			return (node.content ?? []).flatMap((item) =>
				(item.content ?? []).flatMap((child) =>
					richTextParagraphs(child, assets, {
						style: "ListParagraph",
						numId,
						level: Math.min(level, 8),
					}),
				),
			);
		}
		case "image": {
			const source = node.attrs?.src;
			const match =
				typeof source === "string"
					? /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(source)
					: null;
			if (!match)
				throw new Error(
					"Word export needs embedded PNG, JPEG or GIF images. Reinsert this image from a file, or export PDF instead.",
				);
			let bytes: Uint8Array;
			try {
				bytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0));
			} catch {
				throw new Error("An embedded document image could not be decoded.");
			}
			const index = assets.images.length + 1;
			const name = `media/image${index}.${match[1]}`;
			assets.images.push({ name: `word/${name}`, data: bytes });
			assets.links.push({
				id: `image${index}`,
				type: `${REL_NS}/image`,
				target: name,
			});
			const intrinsic = imageSize(bytes, match[1]!);
			const boundedDimension = (value: unknown) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value > 0 &&
				value <= 100000
					? value
					: undefined;
			const width =
				boundedDimension(node.attrs?.width) ??
				boundedDimension(intrinsic?.width);
			const height =
				boundedDimension(node.attrs?.height) ??
				(width && intrinsic?.width && intrinsic.height
					? (width * intrinsic.height) / intrinsic.width
					: undefined);
			if (!width || !height || !Number.isFinite(height))
				throw new Error(
					"An image has no readable size. Reinsert it before exporting Word.",
				);
			const scale = Math.min(1, 624 / width, 864 / height);
			const cx = Math.round(width * scale * 9525),
				cy = Math.round(height * scale * 9525);
			const alt = xmlEscape(
				typeof node.attrs?.alt === "string" ? node.attrs.alt : "Document image",
			);
			return [
				paragraphXml(
					`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="Image ${index}" descr="${alt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Image ${index}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image${index}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
					inherited,
				),
			];
		}
		case "horizontalRule":
			return [paragraphXml("", { style: "HorizontalRule" })];
		default: {
			if (typeof node.text === "string") {
				return [paragraphXml(runXml(node.text), inherited)];
			}
			if (node.content) {
				return node.content.flatMap((child) =>
					richTextParagraphs(child, assets, inherited),
				);
			}
			return [];
		}
	}
}

const STYLES_XML =
	`<w:styles xmlns:w="${WORD_NS}">` +
	'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
	'<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
	[1, 2, 3, 4]
		.map(
			(level) =>
				`<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
				`<w:pPr><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${
					360 - level * 40
				}" w:after="120"/></w:pPr>` +
				`<w:rPr><w:b/><w:sz w:val="${36 - level * 4}"/></w:rPr></w:style>`,
		)
		.join("") +
	'<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
	'<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
	'<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="360"/></w:pPr>' +
	'<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
	'<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="HorizontalRule"><w:name w:val="Horizontal Rule"/><w:basedOn w:val="Normal"/>' +
	'<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:style>' +
	"</w:styles>";

const ORDERED_FORMATS = ["decimal", "lowerLetter", "lowerRoman"] as const;
// Plain Unicode marks, deliberately not the Symbol-font `F0B7` trick: the
// glyph then survives in readers that never resolve the Symbol typeface.
const BULLET_MARKS = ["•", "◦", "▪"] as const;

function abstractNum(id: number, ordered: boolean): string {
	const levels = Array.from({ length: 9 }, (_unused, level) => {
		const format = ordered ? ORDERED_FORMATS[level % 3]! : "bullet";
		const text = ordered
			? `%${level + 1}.`
			: BULLET_MARKS[level % BULLET_MARKS.length]!;
		return (
			`<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
			`<w:lvlText w:val="${xmlEscape(text)}"/><w:lvlJc w:val="left"/>` +
			`<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr>` +
			"</w:lvl>"
		);
	}).join("");
	return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

const NUMBERING_XML =
	`<w:numbering xmlns:w="${WORD_NS}">` +
	abstractNum(0, false) +
	abstractNum(1, true) +
	`<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
	`<w:num w:numId="${ORDERED_NUM_ID}"><w:abstractNumId w:val="1"/></w:num>` +
	"</w:numbering>";

/** Build the `.docx` bytes for a document output's current revision. */
export async function buildDocx(
	content: DocumentContent,
	title: string,
): Promise<Uint8Array> {
	const assets: DocumentAssets = { links: [], images: [] };
	const rich = content.richText?.content ?? [];
	const body =
		rich.length > 0
			? rich.flatMap((node) => richTextParagraphs(node, assets))
			: content.blocks.flatMap(blockParagraphs);
	const heading = paragraphXml(runXml(title), { style: "Heading1" });
	const document =
		`<w:document xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>` +
		heading +
		(body.length > 0 ? body.join("") : paragraphXml("")) +
		'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
		'<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
		"</w:sectPr></w:body></w:document>";

	return createZip([
		xmlPart(
			"[Content_Types].xml",
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				["png", "jpeg", "gif"]
					.map(
						(ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`,
					)
					.join("") +
				'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
				'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
				'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
				"</Types>",
		),
		xmlPart(
			"_rels/.rels",
			relationships([
				{
					id: "rId1",
					type: `${REL_NS}/officeDocument`,
					target: "word/document.xml",
				},
			]),
		),
		xmlPart("word/document.xml", document),
		xmlPart(
			"word/_rels/document.xml.rels",
			relationships([
				{ id: "rId1", type: `${REL_NS}/styles`, target: "styles.xml" },
				{ id: "rId2", type: `${REL_NS}/numbering`, target: "numbering.xml" },
				...assets.links,
			]),
		),
		xmlPart("word/styles.xml", STYLES_XML),
		xmlPart("word/numbering.xml", NUMBERING_XML),
		...assets.images,
	]);
}
