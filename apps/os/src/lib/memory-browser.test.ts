import { describe, expect, it } from "vite-plus/test";
import {
	memorySearchSchema,
	memoryText,
	filterMemoryRows,
	memoryPage,
	type MemoryTableRow,
} from "./memory-browser";

describe("Memory tab URL state", () => {
	it("restores a filtered hygiene tab and rejects invalid pagination", () => {
		expect(
			memorySearchSchema.parse({
				tab: "stale",
				confidence: "80",
				page: "2",
				q: "deployment",
			}),
		).toMatchObject({
			tab: "stale",
			page: 2,
			confidence: "80",
			q: "deployment",
		});
		expect(
			memorySearchSchema.parse({ tab: "unknown", page: -8 }),
		).toMatchObject({ tab: "observations", page: 0 });
	});
});
describe("Memory text", () => {
	it("collapses equal title/body with whitespace differences while retaining full text", () => {
		const body = "Always discover the namespace first.";
		expect(memoryText(`  ${body}\n`, body)).toEqual({
			title: null,
			body,
			line: body,
		});
	});
	it("keeps a distinct title and does not compare truncated previews", () => {
		const prefix = "x".repeat(250);
		expect(memoryText(`${prefix} title`, `${prefix} body`).title).toBe(
			`${prefix} title`,
		);
		expect(memoryText("Short title", "Long evidence").line).toBe("Short title");
	});
});
describe("Memory pagination", () => {
	const rows: MemoryTableRow[] = Array.from({ length: 47 }, (_, i) => ({
		id: String(i).padStart(2, "0"),
		body: `Memory ${i}`,
		source: i % 2 ? "manual" : "feedback",
		confidence: i % 2 ? 0.9 : 0.5,
		updated: "2026-10-20",
		domain: "engineering",
	}));
	it("limits pages without overlap or lost rows", () => {
		expect(memoryPage(rows, 0)).toHaveLength(20);
		expect(memoryPage(rows, 1)[0]?.id).toBe("20");
		expect(memoryPage(rows, 2)).toHaveLength(7);
	});
	it("filters and sorts before slicing the page", () => {
		const state = memorySearchSchema.parse({
			source: "manual",
			confidence: "80",
			sort: "confidence",
		});
		const filtered = filterMemoryRows(rows, state);
		expect(filtered).toHaveLength(23);
		expect(memoryPage(filtered, 1)).toHaveLength(3);
		expect(filtered.every((row) => row.confidence === 0.9)).toBe(true);
	});
});
