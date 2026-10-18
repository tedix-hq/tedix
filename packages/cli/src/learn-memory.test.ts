import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCandidates, runMemoryImport } from "./learn-memory";

test("memory import understands nested metadata and skips references and stale notes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-fixture-"));
	try {
		for (const [name, type, body] of [
			[
				"a",
				"feedback",
				"Why: concise replies save time. How to apply: brief status.",
			],
			["b", "project", "Why: fictional Meadow."],
			["c", "reference", "Docs."],
			["d", "feedback", "SUPERSEDED"],
		])
			writeFileSync(
				join(dir, `${name}.md`),
				`---\nname: ${name}\ndescription: "Always show short status"\nmetadata:\n  type: ${type}\n  originSessionId: fictional-session\n---\n${body}`,
			);
		const rows = memoryCandidates(dir);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.sourceFile).toBe(join(dir, "a.md"));
		expect(memoryCandidates(dir, { date: "1999-01-01" })).toHaveLength(0);
		let called = false;
		const out: string[] = [];
		await runMemoryImport(["--directory", dir], {
			write: (s) => out.push(s),
			read: async () => {
				called = true;
				return {};
			},
		});
		expect(called).toBe(false);
		expect(JSON.parse(out[0]!).count).toBe(2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
