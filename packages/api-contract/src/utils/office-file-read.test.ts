import { describe, expect, it } from "vite-plus/test";
import { officeExtractBlocks, officeExtractText } from "./office-file-blocks";
import { officeFileFormat, readOfficeFile } from "./office-file-read";

async function deflate(bytes: Uint8Array) {
	const stream = new Response(bytes as BodyInit).body!.pipeThrough(
		new CompressionStream("deflate-raw"),
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A tiny zip writer for fixtures; the reader ignores checksums. */
async function zip(files: Record<string, string>) {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [index, [name, text]] of Object.entries(files).entries()) {
		const raw = encoder.encode(text);
		// Alternate stored and deflated parts so both paths run.
		const method = index % 2 === 0 ? 8 : 0;
		const data = method === 8 ? await deflate(raw) : raw;
		const nameBytes = encoder.encode(name);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, method, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, method, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		locals.push(local);
		centrals.push(central);
		offset += local.length;
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, centrals.length, true);
	ev.setUint16(10, centrals.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + centralSize + 22);
	let cursor = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, cursor);
		cursor += part.length;
	}
	return out;
}

const REL =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function xlsxFixture() {
	return zip({
		"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; ideas" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
		"xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Date</t></si><si><r><t>Am</t></r><r><t>ount</t></r></si><si><t>Paper</t></si><si><t>Ink</t><rPh><t>ignored</t></rPh></si></sst>`,
		"xl/styles.xml": `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45658</v></c><c r="C2"><v>12.5</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>45659</v></c><c r="C3"><v>7.5</v></c><c r="E3" t="b"><v>1</v></c></row><row r="5"><c r="C5"><f>SUM(C2:C3)</f><v>20</v></c></row></sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Buy &lt;more&gt; paper</t></is></c></row></sheetData></worksheet>`,
	});
}

describe("officeFileFormat", () => {
	it("reads the extension first, then the declared type", () => {
		expect(officeFileFormat("Q3.XLSX")).toBe("xlsx");
		expect(officeFileFormat("people.tsv")).toBe("csv");
		expect(officeFileFormat("notes", "text/csv")).toBe("csv");
		expect(
			officeFileFormat(
				"deck",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			),
		).toBe("pptx");
		expect(officeFileFormat("photo.png", "image/png")).toBeNull();
	});
});

describe("readOfficeFile", () => {
	it("reads CSV with quotes, numbers and a detected delimiter", async () => {
		const csv = new TextEncoder().encode(
			'﻿Name;Amount;Code\r\n"Smith; Jo";12.5;"007"\r\n"Line\nbreak";-3;\r\n',
		);
		const content = await readOfficeFile(csv, "csv");
		expect(content).toEqual({
			kind: "sheet",
			format: "csv",
			truncated: false,
			sheets: [
				{
					name: "Sheet1",
					formulas: [],
					rows: [
						["Name", "Amount", "Code"],
						["Smith; Jo", 12.5, "007"],
						["Line\nbreak", -3],
					],
				},
			],
		});
	});

	it("reads every XLSX sheet with shared strings, dates, booleans and formulas", async () => {
		const content = await readOfficeFile(await xlsxFixture(), "xlsx");
		if (content.kind !== "sheet") throw new Error("expected a sheet");
		expect(content.sheets.map((sheet) => sheet.name)).toEqual([
			"Budget",
			"Notes & ideas",
		]);
		expect(content.sheets[0]!.rows).toEqual([
			["Item", "Date", "Amount"],
			["Paper", "2025-01-01", 12.5],
			["Ink", "2025-01-02", 7.5, null, true],
			[],
			[null, null, 20],
		]);
		expect(content.sheets[0]!.formulas).toEqual([
			{ row: 4, column: 2, formula: "SUM(C2:C3)" },
		]);
		expect(content.sheets[1]!.rows).toEqual([["Buy <more> paper"]]);
	});

	it("reads DOCX headings, paragraphs, lists and tables in order", async () => {
		const w =
			'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
		const bytes = await zip({
			"word/styles.xml": `<w:styles ${w}><w:style w:styleId="Kop1"><w:name w:val="heading 1"/></w:style></w:styles>`,
			"word/document.xml": `<w:document ${w}><w:body><w:p><w:pPr><w:pStyle w:val="Kop1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Steps</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Ada</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Lead</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:sectPr/></w:body></w:document>`,
		});
		expect(await readOfficeFile(bytes, "docx")).toEqual({
			kind: "document",
			format: "docx",
			truncated: false,
			blocks: [
				{ type: "heading", level: 1, text: "Plan" },
				{ type: "paragraph", text: "Hello world" },
				{ type: "heading", level: 2, text: "Steps" },
				{ type: "paragraph", text: "• First" },
				{
					type: "table",
					rows: [
						["Name", "Role"],
						["Ada", "Lead"],
					],
				},
			],
		});
	});

	it("reads PPTX slide titles, text and speaker notes in deck order", async () => {
		const ns = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"`;
		const slide = (title: string, lines: string[]) =>
			`<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		const bytes = await zip({
			"ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
			"ppt/slides/slide1.xml": slide("Results", ["Up 10%"]),
			"ppt/slides/slide2.xml": slide("Welcome", ["Agenda", "Goals"]),
			"ppt/slides/_rels/slide2.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
			"ppt/notesSlides/notesSlide1.xml": `<p:notes ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
		});
		expect(await readOfficeFile(bytes, "pptx")).toEqual({
			kind: "slides",
			format: "pptx",
			truncated: false,
			slides: [
				{ title: "Welcome", text: ["Agenda", "Goals"], notes: "Say hello" },
				{ title: "Results", text: ["Up 10%"] },
			],
		});
	});

	it("rejects files that are not zips", async () => {
		await expect(
			readOfficeFile(new TextEncoder().encode("not a zip"), "xlsx"),
		).rejects.toThrow("not an Office file");
	});
});

describe("officeExtractBlocks", () => {
	it("labels sheet cells by column letter and row number", async () => {
		const content = await readOfficeFile(await xlsxFixture(), "xlsx");
		const blocks = officeExtractBlocks(content);
		expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Budget" });
		expect(blocks[1]).toMatchObject({
			type: "table",
			headers: ["Row", "A", "B", "C", "D", "E"],
		});
		const text = officeExtractText(blocks);
		expect(text).toContain("| 2 | Paper | 2025-01-01 | 12.5 |  |  |");
		expect(text).toContain("## Notes & ideas");
	});

	it("keeps the first 200 rows and says so", async () => {
		const csv = Array.from({ length: 450 }, (_, index) => `${index},x`).join(
			"\n",
		);
		const content = await readOfficeFile(new TextEncoder().encode(csv), "csv");
		const blocks = officeExtractBlocks(content);
		const table = blocks.find((block) => block.type === "table");
		expect(table?.type === "table" && table.rows.length).toBe(200);
		expect(officeExtractText(blocks)).toContain(
			"Showing rows 1 to 200 of 450.",
		);
	});

	it("stops at the character budget with a note", () => {
		const blocks = officeExtractBlocks({
			kind: "document",
			format: "docx",
			truncated: false,
			blocks: Array.from({ length: 20 }, () => ({
				type: "paragraph" as const,
				text: "x".repeat(4_000),
			})),
		});
		expect(blocks).toHaveLength(13);
		expect(blocks.at(-1)).toEqual({
			type: "paragraph",
			text: "This is the start of the file only. Make an editable copy to work with all of it.",
		});
	});
});
