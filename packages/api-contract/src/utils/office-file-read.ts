/**
 * Reads uploaded spreadsheets, Word documents and slide decks into plain
 * structures: rows per sheet, headings/paragraphs/tables, and slide text.
 *
 * Office files are zips of XML parts. The zip is read here and inflated with
 * the platform's own `DecompressionStream("deflate-raw")`, which Workers,
 * browsers and Node all provide, and the XML goes through a small tokenizer
 * below, so the same code runs in the API, the workspace object and the
 * browser without a parsing dependency. Formatting, images and charts are
 * ignored: the goal is the words and numbers.
 */

export type OfficeFileFormat = "csv" | "xlsx" | "docx" | "pptx";
export type OfficeCell = string | number | boolean | null;

export interface OfficeSheet {
	name: string;
	/** Row-major values; row 0 is spreadsheet row 1, column 0 is column A. */
	rows: OfficeCell[][];
	/** Formulas as written in the file, without the leading `=`. */
	formulas: Array<{ row: number; column: number; formula: string }>;
}

export type OfficeDocumentBlock =
	| { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
	| { type: "paragraph"; text: string }
	| { type: "table"; rows: string[][] };

export interface OfficeSlide {
	title: string;
	text: string[];
	notes?: string;
}

export type OfficeFileContent = { truncated: boolean } & (
	| { kind: "sheet"; format: "csv" | "xlsx"; sheets: OfficeSheet[] }
	| { kind: "document"; format: "docx"; blocks: OfficeDocumentBlock[] }
	| { kind: "slides"; format: "pptx"; slides: OfficeSlide[] }
);

/** Parsing stops here; larger files are read up to the limit and marked truncated. */
export const OFFICE_READ_LIMITS = {
	rows: 50_000,
	columns: 702,
	sheets: 32,
	blocks: 10_000,
	slides: 500,
	/** Total bytes inflated from one file, so a small zip cannot expand without bound. */
	inflatedBytes: 64 * 1024 * 1024,
};

const EXTENSIONS: Record<string, OfficeFileFormat> = {
	csv: "csv",
	tsv: "csv",
	xlsx: "xlsx",
	xlsm: "xlsx",
	docx: "docx",
	pptx: "pptx",
};
const MIME_TYPES: Record<string, OfficeFileFormat> = {
	"text/csv": "csv",
	"text/tab-separated-values": "csv",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"pptx",
};

/** The readable format of a file by its name, then its declared type; null when unsupported. */
export function officeFileFormat(
	filename: string,
	mimeType?: string,
): OfficeFileFormat | null {
	const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
	return (
		(extension ? EXTENSIONS[extension] : undefined) ??
		(mimeType ? MIME_TYPES[mimeType.toLowerCase()] : undefined) ??
		null
	);
}

export async function readOfficeFile(
	bytes: Uint8Array,
	format: OfficeFileFormat,
): Promise<OfficeFileContent> {
	if (format === "csv") return readCsv(bytes);
	const zip = new ZipReader(bytes);
	if (format === "xlsx") return readXlsx(zip);
	if (format === "docx") return readDocx(zip);
	return readPptx(zip);
}

// ---------------------------------------------------------------------------
// Zip

interface ZipFileEntry {
	method: number;
	compressedSize: number;
	size: number;
	offset: number;
}

class ZipReader {
	readonly #bytes: Uint8Array;
	readonly #view: DataView;
	readonly #entries = new Map<string, ZipFileEntry>();
	#inflated = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const end = this.#findEnd();
		let offset = this.#view.getUint32(end + 16, true);
		const count = this.#view.getUint16(end + 10, true);
		for (let index = 0; index < count; index += 1) {
			if (this.#u32(offset) !== 0x02014b50)
				throw new Error("This file is damaged or is not an Office file.");
			const flags = this.#view.getUint16(offset + 8, true);
			const nameLength = this.#view.getUint16(offset + 28, true);
			const extraLength = this.#view.getUint16(offset + 30, true);
			const commentLength = this.#view.getUint16(offset + 32, true);
			const name = new TextDecoder().decode(
				bytes.subarray(offset + 46, offset + 46 + nameLength),
			);
			if (flags & 1)
				throw new Error("This file is password protected and cannot be read.");
			this.#entries.set(name.replace(/^\/+/, ""), {
				method: this.#view.getUint16(offset + 10, true),
				compressedSize: this.#u32(offset + 20),
				size: this.#u32(offset + 24),
				offset: this.#u32(offset + 42),
			});
			offset += 46 + nameLength + extraLength + commentLength;
		}
	}

	#u32(offset: number) {
		if (offset < 0 || offset + 4 > this.#bytes.length)
			throw new Error("This file is damaged or is not an Office file.");
		return this.#view.getUint32(offset, true);
	}

	#findEnd() {
		const stop = Math.max(0, this.#bytes.length - 65_557);
		for (let offset = this.#bytes.length - 22; offset >= stop; offset -= 1) {
			if (this.#view.getUint32(offset, true) === 0x06054b50) return offset;
		}
		throw new Error("This file is damaged or is not an Office file.");
	}

	has(name: string) {
		return this.#entries.has(name);
	}

	async text(name: string): Promise<string | null> {
		const entry = this.#entries.get(name);
		if (!entry) return null;
		if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff)
			throw new Error("This file is too large to read.");
		if (this.#u32(entry.offset) !== 0x04034b50)
			throw new Error("This file is damaged or is not an Office file.");
		const start =
			entry.offset +
			30 +
			this.#view.getUint16(entry.offset + 26, true) +
			this.#view.getUint16(entry.offset + 28, true);
		const data = this.#bytes.subarray(start, start + entry.compressedSize);
		const budget = OFFICE_READ_LIMITS.inflatedBytes - this.#inflated;
		let content: Uint8Array;
		if (entry.method === 0) content = data;
		else if (entry.method === 8) content = await inflate(data, budget);
		else
			throw new Error("This file uses a compression method Tedix cannot read.");
		this.#inflated += content.length;
		if (this.#inflated > OFFICE_READ_LIMITS.inflatedBytes)
			throw new Error("This file is too large to read.");
		return new TextDecoder().decode(content);
	}
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
	const source = new Response(data as BodyInit).body;
	if (!source) throw new Error("This file could not be read.");
	const reader = source
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel();
			throw new Error("This file is too large to read.");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// XML

export interface XmlElement {
	name: string;
	attrs: Record<string, string>;
	children: Array<XmlElement | string>;
}

const ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
};

function decodeEntities(text: string) {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
		if (entity[0] === "#") {
			const code =
				entity[1] === "x" || entity[1] === "X"
					? Number.parseInt(entity.slice(2), 16)
					: Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: match;
		}
		return ENTITIES[entity] ?? match;
	});
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

interface XmlHandlers {
	open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
	close(name: string): void;
	text(text: string): void;
}

/** Streams tags and text. Entity declarations are never expanded. */
export function scanXml(xml: string, handlers: XmlHandlers) {
	let index = 0;
	while (index < xml.length) {
		const lt = xml.indexOf("<", index);
		if (lt === -1) {
			const tail = xml.slice(index);
			if (tail) handlers.text(decodeEntities(tail));
			break;
		}
		if (lt > index) handlers.text(decodeEntities(xml.slice(index, lt)));
		if (xml.startsWith("<!--", lt)) {
			const end = xml.indexOf("-->", lt + 4);
			index = end === -1 ? xml.length : end + 3;
		} else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt + 9);
			handlers.text(xml.slice(lt + 9, end === -1 ? xml.length : end));
			index = end === -1 ? xml.length : end + 3;
		} else if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
			const end = xml.indexOf(">", lt);
			index = end === -1 ? xml.length : end + 1;
		} else if (xml[lt + 1] === "/") {
			const end = xml.indexOf(">", lt);
			handlers.close(xml.slice(lt + 2, end === -1 ? xml.length : end).trim());
			index = end === -1 ? xml.length : end + 1;
		} else {
			let end = lt + 1;
			let quote = "";
			for (; end < xml.length; end += 1) {
				const char = xml[end];
				if (quote) {
					if (char === quote) quote = "";
				} else if (char === '"' || char === "'") quote = char;
				else if (char === ">") break;
			}
			const raw = xml.slice(lt + 1, end);
			const selfClosing = raw.endsWith("/");
			const body = selfClosing ? raw.slice(0, -1) : raw;
			const nameEnd = body.search(/[\s]/);
			const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
			const attrs: Record<string, string> = {};
			if (nameEnd !== -1) {
				for (const match of body.slice(nameEnd).matchAll(ATTRIBUTE))
					attrs[match[1]!] = decodeEntities(match[3] ?? match[4] ?? "");
			}
			handlers.open(name, attrs, selfClosing);
			if (selfClosing) handlers.close(name);
			index = end + 1;
		}
	}
}

export function parseXml(xml: string): XmlElement {
	const root: XmlElement = { name: "#document", attrs: {}, children: [] };
	const stack = [root];
	scanXml(xml, {
		open(name, attrs) {
			const element: XmlElement = { name, attrs, children: [] };
			stack.at(-1)!.children.push(element);
			stack.push(element);
		},
		close() {
			if (stack.length > 1) stack.pop();
		},
		text(text) {
			stack.at(-1)!.children.push(text);
		},
	});
	return root;
}

function localName(name: string) {
	const colon = name.indexOf(":");
	return colon === -1 ? name : name.slice(colon + 1);
}

function attr(element: XmlElement, name: string) {
	for (const [key, value] of Object.entries(element.attrs))
		if (localName(key) === name) return value;
	return undefined;
}

/** The relationship id (`r:id`), not a plain `id` beside it. */
function relationshipId(element: XmlElement) {
	for (const [key, value] of Object.entries(element.attrs))
		if (key.includes(":") && localName(key) === "id") return value;
	return undefined;
}

function childElements(element: XmlElement, name?: string) {
	return element.children.filter(
		(child): child is XmlElement =>
			typeof child !== "string" && (!name || localName(child.name) === name),
	);
}

function firstChild(element: XmlElement, name: string) {
	return childElements(element, name)[0];
}

function* descendants(
	element: XmlElement,
	name: string,
): Generator<XmlElement> {
	for (const child of childElements(element)) {
		if (localName(child.name) === name) yield child;
		yield* descendants(child, name);
	}
}

function relationships(xml: string | null, base: string) {
	const targets = new Map<string, { target: string; type: string }>();
	if (!xml) return targets;
	for (const rel of descendants(parseXml(xml), "Relationship")) {
		const id = attr(rel, "Id");
		const target = attr(rel, "Target");
		if (!id || !target || attr(rel, "TargetMode") === "External") continue;
		targets.set(id, {
			target: resolvePart(base, target),
			type: attr(rel, "Type") ?? "",
		});
	}
	return targets;
}

/** Resolves a relationship target against the folder of the part that names it. */
function resolvePart(base: string, target: string) {
	const parts = target.startsWith("/") ? [] : base.split("/").filter(Boolean);
	for (const segment of target.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return parts.join("/");
}

function relsPath(part: string) {
	const slash = part.lastIndexOf("/");
	return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

function folder(part: string) {
	return part.slice(0, part.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// CSV

function decodeText(bytes: Uint8Array) {
	if (bytes[0] === 0xff && bytes[1] === 0xfe)
		return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		// Older spreadsheet exports write single-byte text; keep every character readable.
		return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
	}
}

function csvDelimiter(text: string) {
	const firstLine = text.slice(0, text.search(/\r?\n|$/));
	let best = ",";
	let bestCount = 0;
	for (const delimiter of [",", ";", "\t", "|"]) {
		let count = 0;
		let quoted = false;
		for (const char of firstLine) {
			if (char === '"') quoted = !quoted;
			else if (!quoted && char === delimiter) count += 1;
		}
		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}
	return best;
}

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function csvValue(text: string): OfficeCell {
	if (text === "") return null;
	if (PLAIN_NUMBER.test(text)) {
		const value = Number(text);
		if (Number.isFinite(value)) return value;
	}
	return text;
}

function readCsv(bytes: Uint8Array): OfficeFileContent {
	const text = decodeText(bytes);
	const delimiter = csvDelimiter(text);
	const rows: OfficeCell[][] = [];
	let row: OfficeCell[] = [];
	let field = "";
	let quoted = false;
	let wasQuoted = false;
	let truncated = false;
	const endField = () => {
		if (row.length < OFFICE_READ_LIMITS.columns)
			row.push(wasQuoted ? field || null : csvValue(field));
		else truncated = true;
		field = "";
		wasQuoted = false;
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += char;
		} else if (char === '"' && field === "") {
			quoted = true;
			wasQuoted = true;
		} else if (char === delimiter) endField();
		else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			endRow();
			if (rows.length >= OFFICE_READ_LIMITS.rows) {
				truncated = index < text.length - 1;
				break;
			}
		} else field += char;
	}
	if (field !== "" || row.length > 0 || wasQuoted) endRow();
	return {
		kind: "sheet",
		format: "csv",
		truncated,
		sheets: [{ name: "Sheet1", rows: trimRows(rows), formulas: [] }],
	};
}

function trimRows(rows: OfficeCell[][]) {
	for (const row of rows)
		while (row.length > 0 && row.at(-1) === null) row.pop();
	while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
	return rows;
}

// ---------------------------------------------------------------------------
// XLSX

const BUILT_IN_DATE_FORMATS = new Set([
	14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
	45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormat(code: string) {
	const stripped = code
		.replace(/"[^"]*"/g, "")
		.replace(/\[[^\]]*\]/g, "")
		.replace(/\\./g, "");
	return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

async function dateStyles(zip: ZipReader) {
	const xml = await zip.text("xl/styles.xml");
	const dates = new Set<number>();
	if (!xml) return dates;
	const root = parseXml(xml);
	const custom = new Map<number, string>();
	for (const format of descendants(root, "numFmt"))
		custom.set(
			Number(attr(format, "numFmtId")),
			attr(format, "formatCode") ?? "",
		);
	const cellXfs = [...descendants(root, "cellXfs")][0];
	if (!cellXfs) return dates;
	childElements(cellXfs, "xf").forEach((xf, index) => {
		const id = Number(attr(xf, "numFmtId") ?? 0);
		const code = custom.get(id);
		if (code === undefined ? BUILT_IN_DATE_FORMATS.has(id) : isDateFormat(code))
			dates.add(index);
	});
	return dates;
}

function serialDate(serial: number, date1904: boolean) {
	const days = date1904 ? serial + 1462 : serial;
	// Day 60 is the leap day 1900 never had; later serials count it.
	const epoch = Date.UTC(1899, 11, days < 60 ? 31 : 30);
	const ms = Math.round(days * 86_400) * 1000;
	const iso = new Date(epoch + ms).toISOString();
	return serial % 1 === 0
		? iso.slice(0, 10)
		: iso.slice(0, 19).replace("T", " ");
}

function columnIndex(reference: string) {
	let index = 0;
	for (const char of reference) {
		const code = char.charCodeAt(0);
		if (code < 65 || code > 90) break;
		index = index * 26 + (code - 64);
	}
	return index - 1;
}

async function sharedStrings(zip: ZipReader, part: string | undefined) {
	const xml = await zip.text(part ?? "xl/sharedStrings.xml");
	const strings: string[] = [];
	if (!xml) return strings;
	let current: string | null = null;
	let inText = false;
	let phonetic = 0;
	scanXml(xml, {
		open(name) {
			const local = localName(name);
			if (local === "si") current = "";
			else if (local === "rPh") phonetic += 1;
			else if (local === "t" && phonetic === 0) inText = true;
		},
		close(name) {
			const local = localName(name);
			if (local === "si") {
				strings.push(current ?? "");
				current = null;
			} else if (local === "rPh") phonetic -= 1;
			else if (local === "t") inText = false;
		},
		text(text) {
			if (inText && current !== null) current += text;
		},
	});
	return strings;
}

async function readXlsx(zip: ZipReader): Promise<OfficeFileContent> {
	const workbookXml = await zip.text("xl/workbook.xml");
	if (!workbookXml) throw new Error("This file is not a readable spreadsheet.");
	const workbook = parseXml(workbookXml);
	const rels = relationships(
		await zip.text("xl/_rels/workbook.xml.rels"),
		"xl/",
	);
	const sharedPart = [...rels.values()].find((rel) =>
		rel.type.endsWith("/sharedStrings"),
	)?.target;
	const strings = await sharedStrings(zip, sharedPart);
	const dates = await dateStyles(zip);
	const date1904 = [...descendants(workbook, "workbookPr")].some((element) =>
		["1", "true"].includes(attr(element, "date1904") ?? ""),
	);
	const sheets: OfficeSheet[] = [];
	let truncated = false;
	const declared = [...descendants(workbook, "sheet")];
	for (const sheet of declared) {
		if (sheets.length >= OFFICE_READ_LIMITS.sheets) {
			truncated = true;
			break;
		}
		const target = rels.get(relationshipId(sheet) ?? "")?.target;
		const xml = target ? await zip.text(target) : null;
		if (xml === null) continue;
		const read = readWorksheet(xml, strings, dates, date1904);
		truncated ||= read.truncated;
		sheets.push({
			name: attr(sheet, "name") || `Sheet${sheets.length + 1}`,
			rows: read.rows,
			formulas: read.formulas,
		});
	}
	if (sheets.length === 0)
		sheets.push({ name: "Sheet1", rows: [], formulas: [] });
	return { kind: "sheet", format: "xlsx", truncated, sheets };
}

function readWorksheet(
	xml: string,
	strings: string[],
	dates: Set<number>,
	date1904: boolean,
) {
	const rows: OfficeCell[][] = [];
	const formulas: OfficeSheet["formulas"] = [];
	let truncated = false;
	let rowIndex = -1;
	let columnCursor = 0;
	let cell: {
		column: number;
		type: string;
		style: number;
		value: string;
		inline: string;
		formula: string;
	} | null = null;
	let capture: "v" | "t" | "f" | null = null;
	let inSheetData = false;
	let stopped = false;
	scanXml(xml, {
		open(name, attrs) {
			if (stopped) return;
			const local = localName(name);
			if (local === "sheetData") inSheetData = true;
			if (!inSheetData) return;
			if (local === "row") {
				const declared = Number(attrs.r);
				rowIndex =
					Number.isInteger(declared) && declared > 0
						? declared - 1
						: rowIndex + 1;
				columnCursor = 0;
				if (rowIndex >= OFFICE_READ_LIMITS.rows) {
					truncated = true;
					stopped = true;
				}
			} else if (local === "c") {
				const column = attrs.r ? columnIndex(attrs.r) : columnCursor;
				columnCursor = column + 1;
				cell = {
					column,
					type: attrs.t ?? "n",
					style: Number(attrs.s ?? 0),
					value: "",
					inline: "",
					formula: "",
				};
			} else if (cell && (local === "v" || local === "f")) capture = local;
			else if (cell && local === "t") capture = "t";
		},
		close(name) {
			if (stopped) return;
			const local = localName(name);
			if (local === "sheetData") inSheetData = false;
			if (local === "v" || local === "f" || local === "t") capture = null;
			if (local !== "c" || !cell) return;
			const current = cell;
			cell = null;
			if (current.column < 0 || rowIndex < 0) return;
			if (current.column >= OFFICE_READ_LIMITS.columns) {
				truncated = true;
				return;
			}
			const value = cellValue(current, strings, dates, date1904);
			if (value === null && !current.formula) return;
			const row = (rows[rowIndex] ??= []);
			while (row.length < current.column) row.push(null);
			row[current.column] = value;
			if (current.formula)
				formulas.push({
					row: rowIndex,
					column: current.column,
					formula: current.formula,
				});
		},
		text(text) {
			if (!cell || !capture) return;
			if (capture === "v") cell.value += text;
			else if (capture === "f") cell.formula += text;
			else cell.inline += text;
		},
	});
	const dense: OfficeCell[][] = [];
	for (let index = 0; index < rows.length; index += 1)
		dense.push(rows[index] ?? []);
	return { rows: trimRows(dense), formulas, truncated };
}

function cellValue(
	cell: { type: string; style: number; value: string; inline: string },
	strings: string[],
	dates: Set<number>,
	date1904: boolean,
): OfficeCell {
	switch (cell.type) {
		case "s":
			return strings[Number(cell.value)] ?? null;
		case "inlineStr":
			return cell.inline || null;
		case "str":
		case "e":
			return cell.value || null;
		case "b":
			return cell.value === "1";
		default: {
			if (cell.value === "") return null;
			const number = Number(cell.value);
			if (!Number.isFinite(number)) return cell.value;
			return dates.has(cell.style) ? serialDate(number, date1904) : number;
		}
	}
}

// ---------------------------------------------------------------------------
// DOCX

function paragraphText(paragraph: XmlElement): string {
	let text = "";
	const walk = (element: XmlElement) => {
		for (const child of element.children) {
			if (typeof child === "string") continue;
			const local = localName(child.name);
			if (local === "t") text += textOf(child);
			else if (local === "tab") text += "\t";
			else if (local === "br" || local === "cr") text += "\n";
			else if (local === "del" || local === "instrText" || local === "pPr")
				continue;
			else walk(child);
		}
	};
	walk(paragraph);
	return text;
}

function textOf(element: XmlElement): string {
	return element.children
		.map((child) => (typeof child === "string" ? child : textOf(child)))
		.join("");
}

async function headingStyles(zip: ZipReader) {
	const levels = new Map<string, number>();
	const xml = await zip.text("word/styles.xml");
	if (!xml) return levels;
	for (const style of descendants(parseXml(xml), "style")) {
		const id = attr(style, "styleId");
		if (!id) continue;
		const name = attr(firstChild(style, "name") ?? style, "val") ?? "";
		const outline = [...descendants(style, "outlineLvl")][0];
		const match = /^heading\s*(\d)$/i.exec(name);
		if (/^title$/i.test(name)) levels.set(id, 1);
		else if (match) levels.set(id, Number(match[1]));
		else if (outline) levels.set(id, Number(attr(outline, "val") ?? 0) + 1);
	}
	return levels;
}

function headingLevel(
	paragraph: XmlElement,
	styles: Map<string, number>,
): number | null {
	const properties = firstChild(paragraph, "pPr");
	if (!properties) return null;
	const outline = firstChild(properties, "outlineLvl");
	if (outline) {
		const level = Number(attr(outline, "val"));
		if (Number.isInteger(level) && level < 9) return level + 1;
	}
	const style = attr(firstChild(properties, "pStyle") ?? properties, "val");
	if (!style) return null;
	const known = styles.get(style);
	if (known) return known;
	const match = /^heading(\d)$/i.exec(style);
	if (match) return Number(match[1]);
	return /^title$/i.test(style) ? 1 : null;
}

async function readDocx(zip: ZipReader): Promise<OfficeFileContent> {
	const xml = await zip.text("word/document.xml");
	if (!xml) throw new Error("This file is not a readable Word document.");
	const styles = await headingStyles(zip);
	const body = [...descendants(parseXml(xml), "body")][0];
	const blocks: OfficeDocumentBlock[] = [];
	let truncated = false;
	const push = (block: OfficeDocumentBlock) => {
		if (blocks.length >= OFFICE_READ_LIMITS.blocks) truncated = true;
		else blocks.push(block);
	};
	const walk = (element: XmlElement) => {
		for (const child of childElements(element)) {
			const local = localName(child.name);
			if (local === "p") {
				const text = paragraphText(child).trim();
				if (!text) continue;
				const level = headingLevel(child, styles);
				const list = child.children.some(
					(node) =>
						typeof node !== "string" &&
						localName(node.name) === "pPr" &&
						firstChild(node, "numPr"),
				);
				push(
					level
						? {
								type: "heading",
								level: Math.min(4, Math.max(1, level)) as 1 | 2 | 3 | 4,
								text,
							}
						: { type: "paragraph", text: list ? `• ${text}` : text },
				);
			} else if (local === "tbl") {
				const rows = childElements(child, "tr").map((row) =>
					childElements(row, "tc").map((cell) =>
						[...descendants(cell, "p")]
							.map((paragraph) => paragraphText(paragraph).trim())
							.filter(Boolean)
							.join("\n"),
					),
				);
				if (rows.some((row) => row.some(Boolean)))
					push({ type: "table", rows });
			} else if (local !== "sectPr") walk(child);
		}
	};
	if (body) walk(body);
	return { kind: "document", format: "docx", truncated, blocks };
}

// ---------------------------------------------------------------------------
// PPTX

function shapeParagraphs(shape: XmlElement) {
	return [...descendants(shape, "p")]
		.map((paragraph) => paragraphText(paragraph).trim())
		.filter(Boolean);
}

function placeholderType(shape: XmlElement) {
	for (const placeholder of descendants(shape, "ph"))
		return attr(placeholder, "type") ?? "body";
	return null;
}

async function readPptx(zip: ZipReader): Promise<OfficeFileContent> {
	const presentationXml = await zip.text("ppt/presentation.xml");
	if (!presentationXml)
		throw new Error("This file is not a readable presentation.");
	const rels = relationships(
		await zip.text("ppt/_rels/presentation.xml.rels"),
		"ppt/",
	);
	const slides: OfficeSlide[] = [];
	let truncated = false;
	for (const id of descendants(parseXml(presentationXml), "sldId")) {
		if (slides.length >= OFFICE_READ_LIMITS.slides) {
			truncated = true;
			break;
		}
		const part = rels.get(relationshipId(id) ?? "")?.target;
		const xml = part ? await zip.text(part) : null;
		if (!part || xml === null) continue;
		let title = "";
		const text: string[] = [];
		const tree = parseXml(xml);
		for (const shape of descendants(tree, "sp")) {
			const type = placeholderType(shape);
			const lines = shapeParagraphs(shape);
			if (!title && (type === "title" || type === "ctrTitle"))
				title = lines.join(" ");
			else if (type !== "sldNum" && type !== "dt" && type !== "ftr")
				text.push(...lines);
		}
		for (const frame of descendants(tree, "graphicFrame"))
			for (const row of descendants(frame, "tr"))
				text.push(
					childElements(row, "tc")
						.map((cell) => shapeParagraphs(cell).join(" "))
						.join(" | "),
				);
		const slideRels = relationships(
			await zip.text(relsPath(part)),
			folder(part),
		);
		const notesPart = [...slideRels.values()].find((rel) =>
			rel.type.endsWith("/notesSlide"),
		)?.target;
		const notesXml = notesPart ? await zip.text(notesPart) : null;
		const notes = notesXml
			? [...descendants(parseXml(notesXml), "sp")]
					.filter((shape) => placeholderType(shape) === "body")
					.flatMap(shapeParagraphs)
					.join("\n")
			: "";
		slides.push({ title, text, ...(notes ? { notes } : {}) });
	}
	return { kind: "slides", format: "pptx", truncated, slides };
}
