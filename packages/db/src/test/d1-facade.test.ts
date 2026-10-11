import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createD1Facade, D1_MAX_LIKE_PATTERN_BYTES } from "./d1-facade";

let d1: D1Database;

beforeEach(() => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
	sqlite.prepare("INSERT INTO t (title) VALUES (?)").run("x".repeat(80));
	d1 = createD1Facade(sqlite);
});

describe("D1 facade: LIKE/GLOB pattern cap", () => {
	it("rejects a bound pattern over 50 bytes the way D1 does", () => {
		const pattern = `%${"x".repeat(D1_MAX_LIKE_PATTERN_BYTES - 1)}%`;
		expect(() =>
			d1
				.prepare("SELECT id FROM t WHERE title LIKE ? ESCAPE '\\'")
				.bind(pattern),
		).toThrow(/D1_ERROR: LIKE or GLOB pattern too complex/);
	});

	it("rejects an oversized literal pattern at prepare time", () => {
		expect(() =>
			d1.prepare(`SELECT id FROM t WHERE title GLOB '${"x".repeat(51)}'`),
		).toThrow(/D1_ERROR: LIKE or GLOB pattern too complex/);
	});

	it("counts bytes, not characters", () => {
		// 26 two-byte characters: under the cap by length, over it by bytes.
		const pattern = "é".repeat(26);
		expect(() =>
			d1.prepare("SELECT id FROM t WHERE title LIKE ?").bind(pattern),
		).toThrow(/52 bytes/);
	});

	it("accepts a pattern at the cap and ignores non-pattern parameters", async () => {
		const pattern = `%${"x".repeat(D1_MAX_LIKE_PATTERN_BYTES - 2)}%`;
		const result = await d1
			.prepare("SELECT id FROM t WHERE id >= ? AND title LIKE ? AND title <> ?")
			.bind(0, pattern, "y".repeat(500))
			.all();
		expect(result.results).toHaveLength(1);
	});

	it("leaves instr() substring matches uncapped", async () => {
		const result = await d1
			.prepare("SELECT id FROM t WHERE instr(title, ?) > 0")
			.bind("x".repeat(80))
			.all();
		expect(result.results).toHaveLength(1);
	});
});
