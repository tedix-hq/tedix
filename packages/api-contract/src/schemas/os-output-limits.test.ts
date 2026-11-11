import { describe, expect, it } from "vite-plus/test";
import {
	OS_DECK_MAX_SLIDES,
	OS_DOCUMENT_MAX_BLOCKS,
	OS_SHEET_MAX_COLUMNS,
	OS_SHEET_MAX_ROWS,
	OS_SLIDE_MAX_ELEMENTS,
	OS_SLIDE_MAX_TEXT_CHARS,
} from "../utils/os-output-limits";
import { OS_OUTPUT_EMBEDDED_IMAGE_MAX_CHARS } from "../utils/os-output-assets";
import { OsOutputContentSchema } from "./os-workspaces";

const sheet = (rows: number, columns: number) => ({
	kind: "sheet" as const,
	columns: Array.from({ length: Math.min(columns, 2) }, (_, i) => `C${i}`),
	rows: [],
	workbook: {
		activeSheetId: "s",
		sheets: [
			{
				id: "s",
				name: "Sheet",
				columns: Array.from({ length: columns }, (_, i) => ({
					id: `c${i}`,
					label: `C${i}`,
				})),
				rows: Array.from({ length: rows }, () => [null]),
			},
		],
	},
});

const element = (id: string, text = "") => ({
	id,
	type: "text" as const,
	x: 0,
	y: 0,
	width: 10,
	height: 10,
	text,
});
const deck = (
	slides: number,
	elements: ReturnType<typeof element>[] = [],
	notes?: string,
) => ({
	kind: "presentation" as const,
	slides: [],
	deck: {
		width: 1200,
		height: 675,
		activeSlideId: "s0",
		slides: Array.from({ length: slides }, (_, i) => ({
			id: `s${i}`,
			name: `Slide ${i}`,
			elements: i === 0 ? elements : [],
			...(i === 0 && notes ? { notes } : {}),
		})),
	},
});

const ok = (content: unknown) =>
	OsOutputContentSchema.safeParse(content).success;

describe("workspace file size bounds", () => {
	it("holds the decided numbers", () => {
		expect([
			OS_SHEET_MAX_ROWS,
			OS_SHEET_MAX_COLUMNS,
			OS_DECK_MAX_SLIDES,
			OS_SLIDE_MAX_ELEMENTS,
			OS_SLIDE_MAX_TEXT_CHARS,
		]).toEqual([50_000, 702, 500, 1_000, 900_000]);
	});

	it("accepts a sheet of 50,000 rows and of 702 columns, and nothing larger", () => {
		expect(ok(sheet(OS_SHEET_MAX_ROWS, 3))).toBe(true);
		expect(ok(sheet(OS_SHEET_MAX_ROWS + 1, 3))).toBe(false);
		expect(ok(sheet(2, OS_SHEET_MAX_COLUMNS))).toBe(true);
		expect(ok(sheet(2, OS_SHEET_MAX_COLUMNS + 1))).toBe(false);
	});

	it("accepts a deck of 500 slides and a slide of 1,000 elements, and nothing larger", () => {
		expect(ok(deck(OS_DECK_MAX_SLIDES))).toBe(true);
		expect(ok(deck(OS_DECK_MAX_SLIDES + 1))).toBe(false);
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => element(`e${i}`));
		expect(ok(deck(1, many(OS_SLIDE_MAX_ELEMENTS)))).toBe(true);
		expect(ok(deck(1, many(OS_SLIDE_MAX_ELEMENTS + 1)))).toBe(false);
	});

	it("counts a slide's text across its elements and notes up to 900,000 characters", () => {
		const half = "x".repeat(OS_SLIDE_MAX_TEXT_CHARS / 2);
		expect(ok(deck(1, [element("a", half), element("b", half)]))).toBe(true);
		expect(ok(deck(1, [element("a", half), element("b", `${half}x`)]))).toBe(
			false,
		);
		expect(ok(deck(1, [element("a", half)], `${half}x`))).toBe(false);
		// The bound is per slide, not per deck.
		const two = deck(2, [element("a", `${half}${half}`)]);
		two.deck.slides[1]!.elements = [element("b", `${half}${half}`)];
		expect(ok(two)).toBe(true);
	});

	it("accepts a long document and an embedded image as large as one upload", () => {
		const blocks = (count: number) => ({
			kind: "document" as const,
			blocks: Array.from({ length: count }, () => ({
				type: "paragraph" as const,
				text: "p",
			})),
		});
		expect(ok(blocks(OS_DOCUMENT_MAX_BLOCKS))).toBe(true);
		expect(ok(blocks(OS_DOCUMENT_MAX_BLOCKS + 1))).toBe(false);
		const picture = (length: number) =>
			deck(1, [
				{
					...element("p"),
					type: "image" as never,
					src: "data:image/png;base64,".padEnd(length, "A"),
				} as ReturnType<typeof element>,
			]);
		expect(ok(picture(OS_OUTPUT_EMBEDDED_IMAGE_MAX_CHARS))).toBe(true);
		expect(ok(picture(OS_OUTPUT_EMBEDDED_IMAGE_MAX_CHARS + 1))).toBe(false);
	});
});
