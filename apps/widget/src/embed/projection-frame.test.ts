import { describe, expect, it } from "vite-plus/test";
import { projectionEarnsFrame } from "./projection-frame";

const table = {
	layoutSpec: {
		type: "Stack",
		children: [
			{ type: "Heading", text: "Órdenes por estado" },
			{
				type: "Table",
				columns: [{ key: "estado" }, { key: "ordenes" }],
				rows: [{ estado: "Cotización", ordenes: 34 }],
			},
		],
	},
};

describe("projectionEarnsFrame", () => {
	it("leaves a static table to the answer that already states it", () => {
		expect(projectionEarnsFrame(table)).toBe(false);
	});

	it("frames a view a person can operate", () => {
		expect(
			projectionEarnsFrame({
				layoutSpec: {
					type: "Stack",
					children: [{ type: "ActionButton", action: { type: "call_tool" } }],
				},
			}),
		).toBe(true);
	});

	it("frames a chart, which no sentence carries", () => {
		expect(
			projectionEarnsFrame({
				layoutSpec: { type: "BarChart", data: [{ x: 1, y: 2 }] },
			}),
		).toBe(true);
	});

	it("always frames a generated app, which has no prose form", () => {
		expect(projectionEarnsFrame({})).toBe(true);
		expect(projectionEarnsFrame({ layoutSpec: null })).toBe(true);
	});

	it("shows anything it cannot reason about rather than hiding it", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(projectionEarnsFrame({ layoutSpec: circular })).toBe(true);
	});

	it("is not fooled by the word action inside content", () => {
		expect(
			projectionEarnsFrame({
				layoutSpec: { type: "Text", text: "Requiere una action del taller" },
			}),
		).toBe(false);
	});
});
