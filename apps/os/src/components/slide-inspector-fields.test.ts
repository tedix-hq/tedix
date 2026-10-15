import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
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
