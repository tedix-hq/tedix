import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectPromptLessons } from "../../../packages/cli/src/hooks/lesson-selection";
import { cases } from "./cases";
import { regressions, repeats, summarize, type Summary } from "./metrics";

test("production lesson selection meets the frozen baseline in offline CI", async () => {
	const rows = [];
	for (const fixture of cases) {
		for (let trial = 0; trial < repeats; trial++) {
			const output = await selectPromptLessons(
				fixture.lessons,
				fixture.context,
			);
			const success =
				JSON.stringify(output.selectedLessonIds) ===
				JSON.stringify(fixture.expected);
			rows.push({
				vars: { caseId: fixture.id },
				success,
				score: Number(success),
				failureReason: success ? 0 : 1,
				repeatIndex: trial,
			});
		}
	}
	const baseline = JSON.parse(
		readFileSync(new URL("baseline.json", import.meta.url), "utf8"),
	) as Summary;
	expect(
		regressions(baseline, summarize({ results: { results: rows } })),
	).toEqual([]);
	expect(rows.every((row) => row.success)).toBe(true);
});
