import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { alignSlideElements } from "./slide-element-actions";

const box = (
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
): OsPresentationElement => ({
	id,
	type: "shape",
	x,
	y,
	width,
	height,
	style: {},
});

describe("alignSlideElements", () => {
	const a = box("a", 100, 100, 100, 50),
		b = box("b", 300, 200, 200, 100),
		c = box("c", 900, 50, 100, 100);
	it("lines elements up along an edge or centre of the box around them all", () => {
		expect(alignSlideElements([a, b, c], "left")).toEqual([
			{ id: "b", x: 100, y: 200 },
			{ id: "c", x: 100, y: 50 },
		]);
		expect(alignSlideElements([a, b], "right")).toEqual([
			{ id: "a", x: 400, y: 100 },
		]);
		expect(alignSlideElements([a, b], "center")).toEqual([
			{ id: "a", x: 250, y: 100 },
			{ id: "b", x: 200, y: 200 },
		]);
		// a ends at 150, c at 150: already lined up along the bottom.
		expect(alignSlideElements([a, c], "bottom")).toEqual([]);
		expect(alignSlideElements([a, b], "middle")).toEqual([
			{ id: "a", x: 100, y: 175 },
			{ id: "b", x: 300, y: 150 },
		]);
	});
	it("spaces three or more evenly, keeping the outermost in place", () => {
		// 100..1000 holds 400 of width: two gaps of 250.
		expect(alignSlideElements([c, a, b], "distribute-horizontal")).toEqual([
			{ id: "b", x: 450, y: 200 },
		]);
		expect(alignSlideElements([a, b], "distribute-horizontal")).toEqual([]);
		expect(alignSlideElements([a], "left")).toEqual([]);
	});
});
