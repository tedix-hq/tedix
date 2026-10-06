/**
 * Office export fidelity, proven by reading each generated file back.
 *
 * Every assertion here goes through independent parsers — `fflate` unzips the
 * OPC container and `fast-xml-parser` parses the parts — rather than
 * inspecting the strings the generator just built. The question these tests
 * answer is not "did bytes come out" but "does a reader find the cells, the
 * formulas, the list and the slide text that were in the content model".
 */

import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { buildOsOutputOfficeExport } from "./os-output-office";

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@",
	// Office parts are full of single-child sequences; keeping them as arrays
	// makes the assertions independent of how many rows a fixture happens to
	// have.
	isArray: (name) =>
		[
			"row",
			"c",
			"sheet",
			"Relationship",
			"Override",
			"w:p",
			"w:r",
			"w:t",
			"p:sp",
			"a:p",
			"a:r",
			"p:sldId",
		].includes(name),
	parseTagValue: false,
	trimValues: false,
});

/**
 * One parsed OOXML part. The shape is the file's, not ours, so the tests
 * navigate it positionally the way a reader does.
 */
// biome-ignore lint/suspicious/noExplicitAny: parsed OOXML is free-form XML.
type XmlNode = Record<string, any>;

/**
 * The text of an XML node. A `<t xml:space="preserve">` element parses as an
 * object rather than a string, so both shapes have to be read the same way.
 */
function textOf(node: unknown): string {
	if (typeof node === "string") return node;
	if (node && typeof node === "object" && "#text" in node) {
		return String((node as { "#text": unknown })["#text"]);
	}
	return "";
}

/** Unzip an export and parse one part. */
function readPart(file: Uint8Array, path: string): XmlNode {
	const parts = unzipSync(file);
	const part = parts[path];
	if (!part) {
		throw new Error(
			`${path} missing from the package; it holds ${Object.keys(parts).sort().join(", ")}`,
		);
	}
	return parser.parse(new TextDecoder().decode(part));
}

function partNames(file: Uint8Array): string[] {
	return Object.keys(unzipSync(file)).sort();
}

/** Every part an OPC package declares a content type for must exist. */
function expectDeclaredPartsExist(file: Uint8Array): void {
	const names = new Set(partNames(file));
	const types = readPart(file, "[Content_Types].xml");
	for (const override of types.Types.Override as Array<{
		"@PartName": string;
	}>) {
		expect(names).toContain(override["@PartName"].replace(/^\//, ""));
	}
}

/** Every relationship target must resolve to a part in the package. */
function expectRelationshipsResolve(file: Uint8Array): void {
	const parts = unzipSync(file);
	const names = new Set(Object.keys(parts));
	for (const relPath of Object.keys(parts).filter((name) =>
		name.endsWith(".rels"),
	)) {
		const base = relPath.replace(/_rels\/[^/]+$/, "");
		const parsed = readPart(file, relPath);
		for (const relationship of parsed.Relationships.Relationship as Array<{
			"@Target": string;
			"@TargetMode"?: string;
		}>) {
			if (relationship["@TargetMode"] === "External") continue;
			const target = new URL(
				relationship["@Target"],
				`file:///${base}`,
			).pathname.replace(/^\//, "");
			expect(names).toContain(target);
		}
	}
}

describe("xlsx export", () => {
	const workbookContent: OsOutputContent = {
		kind: "sheet",
		columns: ["Deal", "Amount"],
		rows: [
			["Acme", 1200],
			["Globex", 800],
			["Total", 2000],
		],
		workbook: {
			activeSheetId: "pipeline",
			sheets: [
				{
					id: "pipeline",
					name: "Pipeline",
					columns: [
						{ id: "deal", label: "Deal", width: 210 },
						{ id: "amount", label: "Amount", width: 120 },
					],
					rows: [
						[
							{ input: "Acme", value: "Acme" },
							{ input: "1200", value: 1200 },
						],
						[
							{ input: "Globex", value: "Globex" },
							{ input: "800", value: 800 },
						],
						[
							{ input: "Total", value: "Total", format: { bold: true } },
							{
								input: "=SUM(B2:B3)",
								value: 2000,
								format: { numberFormat: "currency" },
							},
						],
					],
					frozenRows: 0,
					frozenColumns: 1,
				},
				{
					id: "notes",
					name: "Notes",
					columns: [{ id: "note", label: "Note", width: 300 }],
					rows: [[{ input: "Renewal risk", value: "Renewal risk" }]],
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	};

	it("carries cells, formulas, types and every sheet into a readable workbook", async () => {
		const file = await buildOsOutputOfficeExport(
			"xlsx",
			workbookContent,
			"Pipeline",
		);
		expect(partNames(file)).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"xl/_rels/workbook.xml.rels",
			"xl/styles.xml",
			"xl/workbook.xml",
			"xl/worksheets/sheet1.xml",
			"xl/worksheets/sheet2.xml",
		]);
		expectDeclaredPartsExist(file);
		expectRelationshipsResolve(file);

		// Both sheets survive, under the author's names.
		const workbook = readPart(file, "xl/workbook.xml");
		expect(
			(workbook.workbook.sheets.sheet as Array<{ "@name": string }>).map(
				(sheet) => sheet["@name"],
			),
		).toEqual(["Pipeline", "Notes"]);

		const sheet = readPart(file, "xl/worksheets/sheet1.xml");
		const rows = sheet.worksheet.sheetData.row as Array<{
			"@r": string;
			c: Array<Record<string, unknown>>;
		}>;
		// Row 1 is the header the column labels produced.
		expect(rows[0]!.c.map((cell) => textOf(cell.is.t))).toEqual([
			"Deal",
			"Amount",
		]);

		// A number stays a number, not text: no `t` attribute and a raw `<v>`.
		const amount = rows[1]!.c[1]!;
		expect(amount["@t"]).toBeUndefined();
		expect(amount.v).toBe("1200");

		// A string is an inline string, so no shared-strings table is needed.
		expect(rows[1]!.c[0]!["@t"]).toBe("inlineStr");
		expect(textOf(rows[1]!.c[0]!.is.t)).toBe("Acme");

		// The formula survives AS a formula, with its cached value beside it.
		const total = rows[3]!.c[1]!;
		expect(total.f).toBe("SUM(B2:B3)");
		expect(total.v).toBe("2000");

		// Frozen columns become a real frozen pane, offset for the header row.
		const pane = sheet.worksheet.sheetViews.sheetView.pane;
		expect(pane["@xSplit"]).toBe("1");
		expect(pane["@ySplit"]).toBe("1");
		expect(pane["@state"]).toBe("frozen");

		// Column widths carry over from the workbook model.
		const cols = sheet.worksheet.cols.col as Array<{ "@width": string }>;
		expect(Number(cols[0]!["@width"])).toBeCloseTo(30, 1);

		const second = readPart(file, "xl/worksheets/sheet2.xml");
		expect(textOf(second.worksheet.sheetData.row[1]!.c[0]!.is.t)).toBe(
			"Renewal risk",
		);
	});

	it("keeps formats addressable and the style table well-formed", async () => {
		const file = await buildOsOutputOfficeExport(
			"xlsx",
			workbookContent,
			"Pipeline",
		);
		const sheet = readPart(file, "xl/worksheets/sheet1.xml");
		const styles = readPart(file, "xl/styles.xml");
		const xfs = styles.styleSheet.cellXfs.xf as Array<Record<string, string>>;
		const fonts = styles.styleSheet.fonts.font as Array<
			Record<string, unknown>
		>;
		// Excel rejects a fills table that does not open with none + gray125.
		const fills = styles.styleSheet.fills.fill as Array<{
			patternFill: { "@patternType": string };
		}>;
		expect(fills[0]!.patternFill["@patternType"]).toBe("none");
		expect(fills[1]!.patternFill["@patternType"]).toBe("gray125");
		expect(Number(styles.styleSheet.cellXfs["@count"])).toBe(xfs.length);

		const totalRow = sheet.worksheet.sheetData.row[3]!;
		const boldCell = totalRow.c[0]!;
		expect(
			fonts[Number(xfs[Number(boldCell["@s"])]!["@fontId"])],
		).toHaveProperty("b");
		// Currency reaches the file as the built-in numFmtId, not as text.
		const currencyCell = totalRow.c[1]!;
		expect(xfs[Number(currencyCell["@s"])]!["@numFmtId"]).toBe("44");
	});

	it("exports a flat sheet body that never grew a workbook", async () => {
		const file = await buildOsOutputOfficeExport(
			"xlsx",
			{
				kind: "sheet",
				columns: ["Region", "Open?"],
				rows: [
					["EMEA", true],
					["APAC", false],
				],
			},
			"Regions",
		);
		const sheet = readPart(file, "xl/worksheets/sheet1.xml");
		const rows = sheet.worksheet.sheetData.row as Array<{
			c: Array<Record<string, unknown>>;
		}>;
		expect(rows[0]!.c.map((cell) => textOf(cell.is.t))).toEqual([
			"Region",
			"Open?",
		]);
		expect(textOf(rows[1]!.c[0]!.is.t)).toBe("EMEA");
		// Booleans keep their type rather than becoming the strings "true"/"false".
		expect(rows[1]!.c[1]!["@t"]).toBe("b");
		expect(rows[1]!.c[1]!.v).toBe("1");
		expect(rows[2]!.c[1]!.v).toBe("0");
	});

	it("escapes text that would otherwise break the XML part", async () => {
		const file = await buildOsOutputOfficeExport(
			"xlsx",
			{
				kind: "sheet",
				columns: ["Note"],
				rows: [['Ship "<Tedix> & co"']],
			},
			"Escapes",
		);
		const sheet = readPart(file, "xl/worksheets/sheet1.xml");
		expect(textOf(sheet.worksheet.sheetData.row[1]!.c[0]!.is.t)).toBe(
			'Ship "<Tedix> & co"',
		);
	});
});

describe("docx export", () => {
	it("carries headings, paragraphs, lists, quotes and code into a readable document", async () => {
		const file = await buildOsOutputOfficeExport(
			"docx",
			{
				kind: "document",
				blocks: [
					{ type: "heading", level: 2, text: "Findings" },
					{ type: "paragraph", text: "The pilot converted." },
					{
						type: "list",
						ordered: true,
						items: ["Instrument the funnel", "Ship the fix"],
					},
					{ type: "quote", text: "Measure the rendered effect." },
					{ type: "code", text: "const x = 1;\nreturn x;" },
				],
			},
			"Launch brief",
		);
		expect(partNames(file)).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"word/_rels/document.xml.rels",
			"word/document.xml",
			"word/numbering.xml",
			"word/styles.xml",
		]);
		expectDeclaredPartsExist(file);
		expectRelationshipsResolve(file);

		const document = readPart(file, "word/document.xml");
		const paragraphs = document["w:document"]["w:body"][
			"w:p"
		] as Array<XmlNode>;
		const text = (paragraph: Record<string, any>): string =>
			((paragraph["w:r"] ?? []) as Array<Record<string, any>>)
				.flatMap((run) => (run["w:t"] ?? []) as unknown[])
				.map(textOf)
				.join("");
		const style = (paragraph: Record<string, any>): string | undefined =>
			paragraph["w:pPr"]?.["w:pStyle"]?.["@w:val"];

		// The output title becomes the document's own top heading.
		expect(text(paragraphs[0]!)).toBe("Launch brief");
		expect(style(paragraphs[0]!)).toBe("Heading1");
		expect(style(paragraphs[1]!)).toBe("Heading2");
		expect(text(paragraphs[1]!)).toBe("Findings");
		expect(text(paragraphs[2]!)).toBe("The pilot converted.");

		// An ordered list is a real Word list: numbered, not hand-prefixed text.
		expect(text(paragraphs[3]!)).toBe("Instrument the funnel");
		expect(paragraphs[3]!["w:pPr"]["w:numPr"]["w:numId"]["@w:val"]).toBe("2");
		expect(text(paragraphs[4]!)).toBe("Ship the fix");

		expect(style(paragraphs[5]!)).toBe("Quote");
		// Code keeps one paragraph per line, so its line structure survives.
		expect(style(paragraphs[6]!)).toBe("CodeBlock");
		expect(text(paragraphs[6]!)).toBe("const x = 1;");
		expect(text(paragraphs[7]!)).toBe("return x;");

		// Both list definitions the paragraphs reference actually exist.
		const numbering = readPart(file, "word/numbering.xml");
		expect(
			(numbering["w:numbering"]["w:num"] as Array<Record<string, string>>).map(
				(num) => num["@w:numId"],
			),
		).toEqual(["1", "2"]);
	});

	it("prefers the rich body and keeps inline marks", async () => {
		const file = await buildOsOutputOfficeExport(
			"docx",
			{
				kind: "document",
				blocks: [{ type: "paragraph", text: "Stale projection" }],
				richText: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "Ship " },
								{ type: "text", text: "now", marks: [{ type: "bold" }] },
								{ type: "text", text: " and " },
								{ type: "text", text: "measure", marks: [{ type: "italic" }] },
							],
						},
						{
							type: "bulletList",
							content: [
								{
									type: "listItem",
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "One bullet" }],
										},
									],
								},
							],
						},
					],
				},
			},
			"Rich brief",
		);
		const document = readPart(file, "word/document.xml");
		const paragraphs = document["w:document"]["w:body"][
			"w:p"
		] as Array<XmlNode>;
		const runs = paragraphs[1]!["w:r"] as Array<Record<string, any>>;
		expect(
			runs.map((run) => (run["w:t"] as unknown[]).map(textOf).join("")),
		).toEqual(["Ship ", "now", " and ", "measure"]);
		expect(runs[1]!["w:rPr"]).toHaveProperty("w:b");
		expect(runs[3]!["w:rPr"]).toHaveProperty("w:i");
		// The stale block projection is not appended on top of the rich body.
		const allText = paragraphs
			.flatMap((paragraph) => (paragraph["w:r"] ?? []) as Array<any>)
			.flatMap((run) => (run["w:t"] ?? []) as unknown[])
			.map(textOf)
			.join(" ");
		expect(allText).not.toContain("Stale projection");
		expect(paragraphs[2]!["w:pPr"]["w:numPr"]["w:numId"]["@w:val"]).toBe("1");
	});
});

describe("pptx export", () => {
	it("carries deck geometry, text, notes and slide order into a readable deck", async () => {
		const file = await buildOsOutputOfficeExport(
			"pptx",
			{
				kind: "presentation",
				slides: [
					{ title: "Q3", bullets: ["Up 12%"], notes: "Open with the number" },
					{ title: "Next", bullets: [] },
				],
				deck: {
					width: 1_200,
					height: 675,
					activeSlideId: "s1",
					slides: [
						{
							id: "s1",
							name: "Q3",
							layout: "title-content",
							background: "#101828",
							elements: [
								{
									id: "t1",
									type: "title",
									x: 72,
									y: 72,
									width: 1_056,
									height: 96,
									text: "Q3",
									style: { fontSize: 44, fontWeight: "bold", color: "#ffffff" },
								},
								{
									id: "b1",
									type: "bullet",
									x: 72,
									y: 200,
									width: 1_056,
									height: 380,
									text: "Up 12%\nTwo new logos",
									style: { fontSize: 24 },
								},
							],
							notes: "Open with the number",
						},
						{
							id: "s2",
							name: "Next",
							layout: "title",
							background: "#ffffff",
							elements: [
								{
									id: "t2",
									type: "title",
									x: 72,
									y: 72,
									width: 1_056,
									height: 96,
									text: "Next",
									style: {},
								},
							],
						},
					],
				},
			},
			"Quarterly",
		);
		expectDeclaredPartsExist(file);
		expectRelationshipsResolve(file);
		const names = partNames(file);
		expect(names).toContain("ppt/slides/slide1.xml");
		expect(names).toContain("ppt/slides/slide2.xml");
		expect(names).toContain("ppt/notesSlides/notesSlide1.xml");
		// The second slide has no notes, so it gets no notes part.
		expect(names).not.toContain("ppt/notesSlides/notesSlide2.xml");

		const presentation = readPart(file, "ppt/presentation.xml");
		expect(
			(presentation["p:presentation"]["p:sldIdLst"]["p:sldId"] as Array<any>)
				.length,
		).toBe(2);
		// A 16:9 widescreen slide, matching the 1200x675 canvas exactly.
		expect(presentation["p:presentation"]["p:sldSz"]["@cx"]).toBe("12192000");
		expect(presentation["p:presentation"]["p:sldSz"]["@cy"]).toBe("6858000");

		const slide = readPart(file, "ppt/slides/slide1.xml");
		expect(
			slide["p:sld"]["p:cSld"]["p:bg"]["p:bgPr"]["a:solidFill"]["a:srgbClr"][
				"@val"
			],
		).toBe("101828");
		const shapes = slide["p:sld"]["p:cSld"]["p:spTree"]["p:sp"] as Array<any>;
		expect(shapes).toHaveLength(2);

		// The title keeps its canvas position: 72px * 10160 EMU per px.
		const titleFrame = shapes[0]!["p:spPr"]["a:xfrm"];
		expect(titleFrame["a:off"]["@x"]).toBe("731520");
		expect(titleFrame["a:ext"]["@cx"]).toBe("10728960");
		const titleRun = shapes[0]!["p:txBody"]["a:p"][0]!["a:r"][0]!;
		expect(titleRun["a:t"]).toBe("Q3");
		// 44px is 35.2pt, and OOXML counts font size in hundredths of a point.
		expect(titleRun["a:rPr"]["@sz"]).toBe("3520");
		expect(titleRun["a:rPr"]["@b"]).toBe("1");
		expect(titleRun["a:rPr"]["a:solidFill"]["a:srgbClr"]["@val"]).toBe(
			"FFFFFF",
		);

		// Each line of a bullet element becomes its own bulleted paragraph.
		const bulletParagraphs = shapes[1]!["p:txBody"]["a:p"] as Array<any>;
		expect(bulletParagraphs.map((p) => p["a:r"][0]!["a:t"])).toEqual([
			"Up 12%",
			"Two new logos",
		]);
		expect(bulletParagraphs[0]!["a:pPr"]["a:buChar"]["@char"]).toBe("•");

		const notes = readPart(file, "ppt/notesSlides/notesSlide1.xml");
		expect(
			notes["p:notes"]["p:cSld"]["p:spTree"]["p:sp"][0]!["p:txBody"]["a:p"][0]![
				"a:r"
			][0]!["a:t"],
		).toBe("Open with the number");
	});

	it("lays out an outline-only presentation that never grew a deck", async () => {
		const file = await buildOsOutputOfficeExport(
			"pptx",
			{
				kind: "presentation",
				slides: [{ title: "Only outline", bullets: ["A", "B"] }],
			},
			"Outline",
		);
		expectRelationshipsResolve(file);
		const slide = readPart(file, "ppt/slides/slide1.xml");
		const shapes = slide["p:sld"]["p:cSld"]["p:spTree"]["p:sp"] as Array<any>;
		expect(shapes[0]!["p:txBody"]["a:p"][0]!["a:r"][0]!["a:t"]).toBe(
			"Only outline",
		);
		expect(
			(shapes[1]!["p:txBody"]["a:p"] as Array<any>).map(
				(p) => p["a:r"][0]!["a:t"],
			),
		).toEqual(["A", "B"]);
	});

	it("refuses a body whose kind does not match the format", async () => {
		await expect(
			buildOsOutputOfficeExport(
				"xlsx",
				{ kind: "document", blocks: [] },
				"Mismatched",
			),
		).rejects.toThrow(/xlsx export needs a sheet body/);
	});
});

describe("document rich formatting and images", () => {
	it("preserves hyperlinks, font size, family, alignment and intrinsic image proportions", async () => {
		const content: OsOutputContent = {
			kind: "document",
			blocks: [],
			richText: {
				type: "doc",
				content: [
					{
						type: "paragraph",
						attrs: { textAlign: "center" },
						content: [
							{
								type: "text",
								text: "Open task",
								marks: [
									{
										type: "textStyle",
										attrs: {
											fontSize: "20px",
											fontFamily: "Georgia, serif",
											color: "#123456",
										},
									},
									{
										type: "link",
										attrs: { href: "https://tedix.dev/work?a=1&b=2" },
									},
								],
							},
						],
					},
					{
						type: "image",
						attrs: {
							src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
							alt: "Receipt",
						},
					},
				],
			},
		};
		const file = await buildOsOutputOfficeExport("docx", content, "Books");
		const parts = unzipSync(file);
		const xml = new TextDecoder().decode(parts["word/document.xml"]);
		expect(xml).toContain('w:ascii="Georgia"');
		expect(xml).toContain('w:sz w:val="30"');
		expect(xml).toContain('w:jc w:val="center"');
		expect(xml).toContain('cx="9525" cy="9525"');
		expect(xml).toContain('w:hyperlink r:id="link1"');
		const rels = readPart(file, "word/_rels/document.xml.rels");
		expect(
			rels.Relationships.Relationship.find(
				(r: XmlNode) => r["@Id"] === "link1",
			)["@Target"],
		).toBe("https://tedix.dev/work?a=1&b=2");
		expect(parts["word/media/image1.png"]).toBeTruthy();
		expectRelationshipsResolve(file);
	});
	it("reports unsupported images instead of exporting a successful-looking incomplete document", async () => {
		await expect(
			buildOsOutputOfficeExport(
				"docx",
				{
					kind: "document",
					blocks: [],
					richText: {
						type: "doc",
						content: [
							{ type: "image", attrs: { src: "data:image/webp;base64,AAAA" } },
						],
					},
				},
				"Books",
			),
		).rejects.toThrow("Reinsert this image");
	});
});
