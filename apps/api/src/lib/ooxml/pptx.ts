/**
 * `.pptx` (PresentationML) written straight from a presentation output's
 * content model.
 *
 * As with the document body, the presentation body has two shapes and the
 * visual one is primary: `deck` is the 1200x675 canvas an author actually laid
 * out, and `slides` is its semantic projection. The deck is used when present,
 * so positions, sizes, colors and per-slide backgrounds survive; the outline is
 * the fallback, laid out as a title-and-bullets slide.
 */

import type {
	OsOutputContent,
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createZip, relationships, xmlEscape, xmlPart } from "./zip";

type PresentationContent = Extract<OsOutputContent, { kind: "presentation" }>;

const DRAWING_NS =
	"http://schemas.openxmlformats.org/drawingml/2006/main" as const;
const PRESENTATION_NS =
	"http://schemas.openxmlformats.org/presentationml/2006/main" as const;
const REL_NS =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships" as const;

/**
 * The canvas is 1200x675 px and a widescreen slide is 12192000x6858000 EMU,
 * so one canvas pixel is exactly 10160 EMU on both axes — the deck's aspect
 * ratio is the slide's, and no letterboxing is needed.
 */
const EMU_PER_PX = 10_160;
const SLIDE_WIDTH_EMU = 12_192_000;
const SLIDE_HEIGHT_EMU = 6_858_000;

/** 1200px across 13.333in is 90px/inch, so one pixel is 0.8pt. */
function fontSize(px: number): number {
	return Math.max(100, Math.round(px * 80));
}

const DEFAULT_FONT_PX: Record<string, number> = {
	title: 44,
	subtitle: 28,
	text: 18,
	bullet: 24,
	label: 14,
	card: 18,
	box: 18,
	shape: 18,
};

function srgb(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
	if (match) return match[1]!.toUpperCase();
	const short = /^#?([0-9a-f]{3})$/i.exec(color.trim());
	if (short) {
		return short[1]!
			.split("")
			.map((digit) => digit + digit)
			.join("")
			.toUpperCase();
	}
	return undefined;
}

const WEIGHT_BOLD = new Set(["semibold", "bold"]);
const TEXT_TYPES = new Set(["title", "subtitle", "text", "bullet", "label"]);

function runProperties(element: OsPresentationElement): string {
	const style = element.style ?? {};
	const size = fontSize(style.fontSize ?? DEFAULT_FONT_PX[element.type] ?? 18);
	const bold = WEIGHT_BOLD.has(style.fontWeight ?? "normal") ? ' b="1"' : "";
	const color = srgb(style.color);
	const fill = color
		? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
		: "";
	const typeface = style.fontFamily
		? `<a:latin typeface="${xmlEscape(style.fontFamily)}"/>`
		: "";
	return `<a:rPr lang="en-US" sz="${size}"${bold} dirty="0">${fill}${typeface}</a:rPr>`;
}

function paragraphs(element: OsPresentationElement): string {
	const style = element.style ?? {};
	const align =
		style.textAlign === "center"
			? ' algn="ctr"'
			: style.textAlign === "right"
				? ' algn="r"'
				: "";
	const bullet =
		element.type === "bullet"
			? '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
			: "<a:buNone/>";
	const lines = (element.text ?? "").split("\n");
	const properties = runProperties(element);
	return lines
		.map((line) => {
			const run =
				line.length > 0
					? `<a:r>${properties}<a:t>${xmlEscape(line)}</a:t></a:r>`
					: `<a:endParaRPr lang="en-US"/>`;
			return `<a:p><a:pPr${align}>${line.length > 0 ? bullet : "<a:buNone/>"}</a:pPr>${run}</a:p>`;
		})
		.join("");
}

function shapeProperties(element: OsPresentationElement): string {
	const style = element.style ?? {};
	const rotation = style.rotation
		? ` rot="${Math.round(style.rotation * 60_000)}"`
		: "";
	const geometry =
		element.type === "divider" || element.type === "arrow" ? "line" : "rect";
	const background = srgb(style.background);
	const fill = background
		? `<a:solidFill><a:srgbClr val="${background}"/></a:solidFill>`
		: "<a:noFill/>";
	const borderColor = srgb(style.borderColor);
	const borderWidth = style.borderWidth ?? (borderColor ? 1 : 0);
	const line =
		borderColor && borderWidth > 0
			? `<a:ln w="${Math.round(borderWidth * 12_700)}"><a:solidFill><a:srgbClr val="${borderColor}"/></a:solidFill></a:ln>`
			: geometry === "line"
				? '<a:ln w="12700"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln>'
				: "";
	const adjust =
		geometry === "rect" && style.borderRadius
			? '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>'
			: `<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>`;
	return (
		`<p:spPr><a:xfrm${rotation}>` +
		`<a:off x="${Math.round(element.x * EMU_PER_PX)}" y="${Math.round(element.y * EMU_PER_PX)}"/>` +
		`<a:ext cx="${Math.max(1, Math.round(element.width * EMU_PER_PX))}" cy="${Math.max(
			1,
			Math.round(element.height * EMU_PER_PX),
		)}"/>` +
		`</a:xfrm>${adjust}${fill}${line}</p:spPr>`
	);
}

/** One shape, or "" for an element this exporter deliberately drops. */
function shapeXml(element: OsPresentationElement, id: number): string {
	// Images and inline SVG are canvas-only: their `src` is a data URI the
	// deck renders, and carrying it would mean embedding media parts. Dropping
	// them is stated in the export docs rather than silently half-rendered.
	if (element.type === "image" || element.type === "svg") return "";
	const hasText = (element.text ?? "").length > 0;
	if (!hasText && TEXT_TYPES.has(element.type)) return "";
	const body = hasText
		? `<p:txBody><a:bodyPr wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(
				element,
			)}</p:txBody>`
		: '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>';
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(element.type)} ${id}"/>` +
		'<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
		shapeProperties(element) +
		body +
		"</p:sp>"
	);
}

function slideXml(slide: OsPresentationCanvasSlide): string {
	const background = srgb(slide.background) ?? "FFFFFF";
	const shapes = slide.elements
		.map((element, index) => shapeXml(element, index + 2))
		.join("");
	return (
		`<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}"><p:cSld>` +
		`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
		'<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
		'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
		shapes +
		"</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
	);
}

function notesSlideXml(notes: string): string {
	const body = notes
		.split("\n")
		.map(
			(line) =>
				`<a:p><a:r><a:rPr lang="en-US" sz="1200" dirty="0"/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`,
		)
		.join("");
	return (
		`<p:notes xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree>` +
		'<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
		'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
		'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
		'<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
		`<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>` +
		"</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
	);
}

/** Lay out one outline slide when the body carries no visual deck. */
function canvasFromOutline(
	slide: PresentationContent["slides"][number],
	index: number,
): OsPresentationCanvasSlide {
	const elements: OsPresentationElement[] = [
		{
			id: `title-${index}`,
			type: "title",
			x: 72,
			y: 72,
			width: 1_056,
			height: 96,
			text: slide.title,
			style: { fontSize: 44, fontWeight: "semibold" },
		},
	];
	if (slide.bullets.length > 0) {
		elements.push({
			id: `bullet-${index}`,
			type: "bullet",
			x: 72,
			y: 200,
			width: 1_056,
			height: 380,
			text: slide.bullets.join("\n"),
			style: { fontSize: 24 },
		});
	}
	return {
		id: `slide-${index}`,
		name: slide.title.slice(0, 200) || `Slide ${index + 1}`,
		layout: slide.bullets.length > 0 ? "title-content" : "title",
		background: "#ffffff",
		elements,
		...(slide.notes ? { notes: slide.notes } : {}),
	};
}

const THEME_XML =
	`<a:theme xmlns:a="${DRAWING_NS}" name="Tedix"><a:themeElements>` +
	'<a:clrScheme name="Tedix"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
	'<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
	'<a:dk2><a:srgbClr val="1F2933"/></a:dk2><a:lt2><a:srgbClr val="F5F7FA"/></a:lt2>' +
	'<a:accent1><a:srgbClr val="2F6FED"/></a:accent1><a:accent2><a:srgbClr val="7A5AF8"/></a:accent2>' +
	'<a:accent3><a:srgbClr val="16A394"/></a:accent3><a:accent4><a:srgbClr val="F79009"/></a:accent4>' +
	'<a:accent5><a:srgbClr val="D92D20"/></a:accent5><a:accent6><a:srgbClr val="475467"/></a:accent6>' +
	'<a:hlink><a:srgbClr val="2F6FED"/></a:hlink><a:folHlink><a:srgbClr val="7A5AF8"/></a:folHlink></a:clrScheme>' +
	'<a:fontScheme name="Tedix"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
	'<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
	'<a:fmtScheme name="Tedix">' +
	'<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
	'<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	'<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	'<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
	"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>" +
	"<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
	'<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
	"</a:fmtScheme></a:themeElements></a:theme>";

const EMPTY_SP_TREE =
	'<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
	'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

const CLR_MAP =
	'<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const SLIDE_MASTER_XML =
	`<p:sldMaster xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
	`<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_SP_TREE}</p:cSld>` +
	CLR_MAP +
	'<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
	"</p:sldMaster>";

const SLIDE_LAYOUT_XML =
	`<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}" type="blank" preserve="1">` +
	`<p:cSld name="Blank">${EMPTY_SP_TREE}</p:cSld>` +
	"<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const NOTES_MASTER_XML =
	`<p:notesMaster xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
	`<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
	CLR_MAP +
	"</p:notesMaster>";

/** Build the `.pptx` bytes for a presentation output's current revision. */
export async function buildPptx(
	content: PresentationContent,
): Promise<Uint8Array> {
	const canvasSlides: OsPresentationCanvasSlide[] =
		content.deck && content.deck.slides.length > 0
			? content.deck.slides
			: content.slides.map(canvasFromOutline);
	// An empty deck still has to be a readable file, not a zero-slide package
	// PowerPoint refuses to open.
	const slides =
		canvasSlides.length > 0
			? canvasSlides
			: [canvasFromOutline({ title: "Untitled", bullets: [] }, 0)];

	const parts = [
		xmlPart(
			"_rels/.rels",
			relationships([
				{
					id: "rId1",
					type: `${REL_NS}/officeDocument`,
					target: "ppt/presentation.xml",
				},
			]),
		),
		xmlPart("ppt/theme/theme1.xml", THEME_XML),
		xmlPart("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER_XML),
		xmlPart(
			"ppt/slideMasters/_rels/slideMaster1.xml.rels",
			relationships([
				{
					id: "rId1",
					type: `${REL_NS}/slideLayout`,
					target: "../slideLayouts/slideLayout1.xml",
				},
				{ id: "rId2", type: `${REL_NS}/theme`, target: "../theme/theme1.xml" },
			]),
		),
		xmlPart("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT_XML),
		xmlPart(
			"ppt/slideLayouts/_rels/slideLayout1.xml.rels",
			relationships([
				{
					id: "rId1",
					type: `${REL_NS}/slideMaster`,
					target: "../slideMasters/slideMaster1.xml",
				},
			]),
		),
		xmlPart("ppt/notesMasters/notesMaster1.xml", NOTES_MASTER_XML),
		xmlPart(
			"ppt/notesMasters/_rels/notesMaster1.xml.rels",
			relationships([
				{ id: "rId1", type: `${REL_NS}/theme`, target: "../theme/theme1.xml" },
			]),
		),
	];

	const notesOverrides: string[] = [];
	for (const [index, slide] of slides.entries()) {
		const number = index + 1;
		parts.push(xmlPart(`ppt/slides/slide${number}.xml`, slideXml(slide)));
		const slideRels: Array<{ id: string; type: string; target: string }> = [
			{
				id: "rId1",
				type: `${REL_NS}/slideLayout`,
				target: "../slideLayouts/slideLayout1.xml",
			},
		];
		if (slide.notes) {
			slideRels.push({
				id: "rId2",
				type: `${REL_NS}/notesSlide`,
				target: `../notesSlides/notesSlide${number}.xml`,
			});
			parts.push(
				xmlPart(
					`ppt/notesSlides/notesSlide${number}.xml`,
					notesSlideXml(slide.notes),
				),
				xmlPart(
					`ppt/notesSlides/_rels/notesSlide${number}.xml.rels`,
					relationships([
						{
							id: "rId1",
							type: `${REL_NS}/notesMaster`,
							target: "../notesMasters/notesMaster1.xml",
						},
						{
							id: "rId2",
							type: `${REL_NS}/slide`,
							target: `../slides/slide${number}.xml`,
						},
					]),
				),
			);
			notesOverrides.push(
				`<Override PartName="/ppt/notesSlides/notesSlide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
			);
		}
		parts.push(
			xmlPart(
				`ppt/slides/_rels/slide${number}.xml.rels`,
				relationships(slideRels),
			),
		);
	}

	// rId1 is the master, then one per slide, then the notes master and theme.
	const notesMasterRelId = `rId${slides.length + 2}`;
	const presentationRels = relationships([
		{
			id: "rId1",
			type: `${REL_NS}/slideMaster`,
			target: "slideMasters/slideMaster1.xml",
		},
		...slides.map((_slide, index) => ({
			id: `rId${index + 2}`,
			type: `${REL_NS}/slide`,
			target: `slides/slide${index + 1}.xml`,
		})),
		{
			id: notesMasterRelId,
			type: `${REL_NS}/notesMaster`,
			target: "notesMasters/notesMaster1.xml",
		},
		{
			id: `rId${slides.length + 3}`,
			type: `${REL_NS}/theme`,
			target: "theme/theme1.xml",
		},
	]);

	const presentation =
		`<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}" saveSubsetFonts="1">` +
		'<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
		`<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>` +
		`<p:sldIdLst>${slides
			.map(
				(_slide, index) =>
					`<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
			)
			.join("")}</p:sldIdLst>` +
		`<p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>` +
		'<p:notesSz cx="6858000" cy="9144000"/>' +
		"</p:presentation>";

	parts.push(
		xmlPart("ppt/presentation.xml", presentation),
		xmlPart("ppt/_rels/presentation.xml.rels", presentationRels),
	);

	const contentTypes =
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
		'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
		'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
		'<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' +
		'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
		slides
			.map(
				(_slide, index) =>
					`<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
			)
			.join("") +
		notesOverrides.join("") +
		"</Types>";

	return createZip([xmlPart("[Content_Types].xml", contentTypes), ...parts]);
}
