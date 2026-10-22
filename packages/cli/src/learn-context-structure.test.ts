import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("learn context stays split by concern", () => {
	for (const concern of ["notes", "candidates", "board", "judge"])
		expect(
			readFileSync(join(import.meta.dir, `learn-context-${concern}.ts`), "utf8")
				.length,
		).toBeGreaterThan(0);

	const entryLines = readFileSync(
		join(import.meta.dir, "learn-context.ts"),
		"utf8",
	).split("\n").length;
	expect(entryLines).toBeLessThanOrEqual(1_100);
});
