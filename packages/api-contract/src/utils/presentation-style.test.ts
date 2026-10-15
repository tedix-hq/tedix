import { describe, expect, it } from "vite-plus/test";
import { OsPresentationElementSchema } from "../schemas/os-workspaces";
import {
	parseSlideText,
	slideArrowPath,
	slideElementStyle,
} from "./presentation-style";

const element = OsPresentationElementSchema.parse({
	id: "text",
	type: "text",
	x: 40,
	y: 80,
	width: 500,
	height: 120,
});

describe("slide styles", () => {
	it("preserves defaults and maps overrides at both canvas and export scale", () => {
		expect(slideElementStyle(element)).toMatchObject({
			fontFamily: "Arial, sans-serif",
			fontWeight: "normal",
			lineHeight: 1.3,
			letterSpacing: "normal",
			borderStyle: undefined,
		});
		const styled = OsPresentationElementSchema.parse({
			...element,
			style: {
				fontWeight: "light",
				lineHeight: 2.5,
				letterSpacing: -1.2,
				borderWidth: 2,
				borderStyle: "dashed",
			},
		});
		expect(slideElementStyle(styled)).toMatchObject({
			fontWeight: 300,
			lineHeight: 2.5,
			letterSpacing: "calc(-1.2 * 100cqw / 1200)",
			borderStyle: "dashed",
		});
		expect(slideElementStyle(styled, "pixels")).toMatchObject({
			fontWeight: 300,
			lineHeight: 2.5,
			letterSpacing: "-1.2px",
			borderWidth: "2px",
			borderStyle: "dashed",
		});
		expect(
			slideElementStyle({
				...element,
				style: { letterSpacing: 0, borderWidth: 1 },
			}),
		).toMatchObject({
			letterSpacing: "calc(0 * 100cqw / 1200)",
			borderStyle: "solid",
		});
		expect(
			slideElementStyle({
				...element,
				style: { borderWidth: 1, borderStyle: "dotted" },
			}).borderStyle,
		).toBe("dotted");
	});

	it("parses multiple bold spans and preserves line breaks and literal unmatched markers", () => {
		expect(parseSlideText("A **bold** and **second\nline**! **open")).toEqual([
			{ text: "A ", bold: false },
			{ text: "bold", bold: true },
			{ text: " and ", bold: false },
			{ text: "second\nline", bold: true },
			{ text: "! **open", bold: false },
		]);
		expect(parseSlideText("****")).toEqual([{ text: "****", bold: false }]);
		expect(parseSlideText("")).toEqual([]);
	});

	it("draws a horizontal shaft and arrowhead inside the box", () => {
		expect(slideArrowPath({ ...element, width: 200, height: 40 })).toBe(
			"M 2 20 H 198 M 180 2 L 198 20 L 180 38",
		);
	});
});
