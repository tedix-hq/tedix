import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	parseHighlightWords,
	slideFieldValue,
	slideInspectorFields,
	type SlideInspectorField,
	writeSlideField,
} from "./slide-inspector-fields";

const element = (
	patch: Partial<OsPresentationElement> = {},
): OsPresentationElement => ({
	id: "e1",
	type: "text",
	x: 100,
	y: 100,
	width: 400,
	height: 100,
	text: "Hello",
	style: {},
	...patch,
});

const labels = (fields: readonly SlideInspectorField[]) =>
	fields.map((field) => field.label);

describe("slide inspector fields", () => {
	it("puts position and size under Advanced for every element type", () => {
		for (const type of ["title", "image", "svg", "shape", "arrow"] as const) {
			const { basic, advanced } = slideInspectorFields(type);
			expect(labels(advanced)).toEqual(
				expect.arrayContaining(["X", "Y", "W", "H"]),
			);
			expect(labels(basic)).not.toContain("X");
		}
	});

	it("offers the controls each type needs", () => {
		const text = slideInspectorFields("text");
		expect(labels(text.basic)).toEqual(
			expect.arrayContaining([
				"Font",
				"Font size",
				"Font weight",
				"Text align",
				"Corner radius",
			]),
		);
		expect(labels(text.advanced)).toEqual(
			expect.arrayContaining([
				"Line height",
				"Letter spacing (px)",
				"Padding",
				"Vertical align",
				"Opacity",
				"Rotation (deg)",
			]),
		);
		expect(labels(slideInspectorFields("image").basic)).toEqual([
			"Image URL",
			"Alt text",
			"Fit",
			"Corner radius",
		]);
		expect(labels(slideInspectorFields("svg").basic)).toEqual([
			"SVG code",
			"Alt text",
			"Fit",
		]);
		expect(labels(slideInspectorFields("shape").basic)).toContain(
			"Corner radius",
		);
	});

	it("writes text padding, vertical alignment and hairline geometry", () => {
		let next = writeSlideField(element(), find("text", "Padding"), "24");
		next = writeSlideField(next, find("text", "Vertical align"), "middle");
		next = writeSlideField(next, find("text", "H"), "1");
		expect(next.style).toMatchObject({ padding: 24, verticalAlign: "middle" });
		expect(next.height).toBe(1);
	});

	it("clamps numbers to the schema and keeps geometry on the canvas", () => {
		const opacity = slideInspectorFields("text").advanced.find(
			(field) => field.label === "Opacity",
		)!;
		expect(writeSlideField(element(), opacity, "3").style.opacity).toBe(1);
		expect(
			writeSlideField(element(), opacity, "").style.opacity,
		).toBeUndefined();
		const x = slideInspectorFields("text").advanced.find(
			(field) => field.label === "X",
		)!;
		expect(writeSlideField(element(), x, "1150").x).toBe(800);
		expect(writeSlideField(element(), x, "").x).toBe(100);
	});

	const find = (
		type: OsPresentationElement["type"],
		label: string,
	): SlideInspectorField => {
		const { basic, advanced } = slideInspectorFields(type);
		return [...basic, ...advanced].find((field) => field.label === label)!;
	};

	it("maps the slide model's element props to basic controls", () => {
		for (const type of ["card", "box"] as const)
			expect(labels(slideInspectorFields(type).basic)).toEqual(
				expect.arrayContaining([
					"Eyebrow",
					"Title",
					"Body",
					"Tone",
					"Highlight words",
				]),
			);
		expect(labels(slideInspectorFields("label").basic)).toContain("Tone");
		expect(labels(slideInspectorFields("bullet").basic)).toEqual(
			expect.arrayContaining(["Items", "Highlight words", "Compact"]),
		);
		expect(labels(slideInspectorFields("arrow").basic)).toEqual([
			"From X",
			"From Y",
			"To X",
			"To Y",
			"Label",
			"Dashed",
			"Line width",
			"Line color",
		]);
		expect(labels(slideInspectorFields("shape").basic)).toEqual([
			"Shape",
			"Fill color",
			"Corner radius",
		]);
	});

	it("writes card parts, tone and highlight words into props", () => {
		const card = element({ type: "card", text: "Fallback" });
		expect(slideFieldValue(card, find("card", "Title"))).toBe("Fallback");
		let next = writeSlideField(card, find("card", "Eyebrow"), "Step");
		next = writeSlideField(next, find("card", "Body"), "Line 1\nLine 2");
		next = writeSlideField(next, find("card", "Tone"), "success");
		next = writeSlideField(
			next,
			find("card", "Highlight words"),
			" fast , fast,, cheap ",
		);
		expect(next.props).toEqual({
			eyebrow: "Step",
			body: "Line 1\nLine 2",
			tone: "success",
			highlight: ["fast", "cheap"],
		});
		expect(slideFieldValue(next, find("card", "Highlight words"))).toBe(
			"fast, cheap",
		);
		next = writeSlideField(next, find("card", "Tone"), "default");
		next = writeSlideField(next, find("card", "Highlight words"), " , ");
		next = writeSlideField(next, find("card", "Eyebrow"), "");
		next = writeSlideField(next, find("card", "Body"), "");
		expect(next.props).toBeUndefined();
	});

	it("writes bullet items as lines of text and the compact toggle", () => {
		const list = element({ type: "bullet", text: undefined });
		const next = writeSlideField(list, find("bullet", "Items"), "A\nB");
		expect(next.text).toBe("A\nB");
		const compact = writeSlideField(next, find("bullet", "Compact"), "true");
		expect(compact.props).toEqual({ compact: true });
		expect(
			writeSlideField(compact, find("bullet", "Compact"), "false").props,
		).toBeUndefined();
	});

	it("stores both arrow endpoints when one coordinate changes", () => {
		const arrow = element({
			type: "arrow",
			x: 100,
			y: 100,
			width: 300,
			height: 60,
		});
		expect(slideFieldValue(arrow, find("arrow", "From X"))).toBe(102);
		const next = writeSlideField(arrow, find("arrow", "To Y"), "900");
		expect(next.props).toEqual({
			from: { x: 102, y: 130 },
			to: { x: 398, y: 675 },
		});
		let styled = writeSlideField(next, find("arrow", "Label"), "calls");
		styled = writeSlideField(styled, find("arrow", "Dashed"), "true");
		styled = writeSlideField(styled, find("arrow", "Line width"), "40");
		styled = writeSlideField(styled, find("arrow", "Line color"), "#ff0000");
		expect(styled.props).toMatchObject({
			label: "calls",
			dashed: true,
			strokeWidth: 24,
			color: "#ff0000",
		});
		expect(writeSlideField(styled, find("arrow", "From X"), "").props).toEqual(
			styled.props,
		);
	});

	it("writes shape kind and a radius that outranks the style radius", () => {
		const shape = element({ type: "shape", style: { borderRadius: 2 } });
		expect(slideFieldValue(shape, find("shape", "Corner radius"))).toBe(2);
		expect(slideFieldValue(shape, find("shape", "Shape"))).toBeUndefined();
		let next = writeSlideField(shape, find("shape", "Shape"), "ellipse");
		next = writeSlideField(next, find("shape", "Corner radius"), "700");
		expect(next.props).toEqual({ kind: "ellipse", radius: 600 });
		expect(
			writeSlideField(next, find("shape", "Corner radius"), "").props,
		).toEqual({ kind: "ellipse" });
	});

	it("parses highlight words within the schema caps", () => {
		expect(parseHighlightWords("")).toBeUndefined();
		expect(
			parseHighlightWords(
				Array.from({ length: 120 }, (_, i) => `w${i}`).join(","),
			),
		).toHaveLength(100);
	});

	it("writes fonts, selects and alt text", () => {
		const { basic } = slideInspectorFields("image");
		const fit = basic.find((field) => field.label === "Fit")!;
		expect(
			writeSlideField(element({ type: "image" }), fit, "cover").style.fit,
		).toBe("cover");
		const alt = basic.find((field) => field.label === "Alt text")!;
		expect(writeSlideField(element(), alt, "Logo").text).toBe("Logo");
		const font = slideInspectorFields("title").basic.find(
			(field) => field.kind === "font",
		)!;
		expect(
			writeSlideField(element(), font, "Space Grotesk, sans-serif").style
				.fontFamily,
		).toBe("Space Grotesk, sans-serif");
		expect(
			writeSlideField(element(), font, "").style.fontFamily,
		).toBeUndefined();
	});
});
