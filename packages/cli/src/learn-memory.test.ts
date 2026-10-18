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

test("an import extracts from the note body locally and uploads only the bounded supported rule", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-body-fixture-"));
	try {
		writeFileSync(
			join(dir, "feedback.md"),
			"---\nname: status\ndescription: Status guidance\ntype: feedback\n---\nWhy: avoid repeated questions.\nHow to apply: Always show concise status.\nPRIVATE_NOTE_DETAIL",
		);
		let modelInput = "";
		let uploaded = "";
		await runMemoryImport(["--directory", dir, "--apply"], {
			defaultTarget: {
				workspace: "fixture",
				organization: "org_fixture",
				org: "org_fixture",
				mcpUrl: "https://fixture.invalid/mcp",
			},
			runModel: async (prompt) => {
				modelInput = prompt;
				return '{"text":"Always show concise status.","quote":"Always show concise status."}';
			},
			read: async (_args, _ms, input) => {
				uploaded = input!;
				return { lessons: [] };
			},
			write: () => {},
		});
		expect(modelInput).toContain("Why: avoid repeated questions");
		expect(uploaded).toContain("Always show concise status.");
		expect(uploaded).toContain("sourceHash");
		expect(uploaded).not.toContain("PRIVATE_NOTE_DETAIL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a saved manifest cannot silently include new or changed notes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-selection-fixture-"));
	try {
		const source = join(dir, "first.md");
		writeFileSync(
			source,
			"---\nname: fixture\ndescription: Always use concise status\ntype: feedback\n---\nWhy: clarity.",
		);
		const manifest = join(dir, "selection.json");
		writeFileSync(
			manifest,
			JSON.stringify(
				memoryCandidates(dir).map(({ sourceFile, sourceHash }) => ({
					sourceFile,
					sourceHash,
				})),
			),
		);
		writeFileSync(
			join(dir, "second.md"),
			"---\nname: other\ndescription: Always include status\ntype: feedback\n---\nNew note.",
		);
		const reports: string[] = [];
		await runMemoryImport(["--directory", dir, "--manifest", manifest], {
			write: (text) => reports.push(text),
		});
		expect(JSON.parse(reports[0]!).count).toBe(1);
		writeFileSync(
			source,
			"---\nname: fixture\ndescription: Changed status guidance\ntype: feedback\n---\nWhy: edited.",
		);
		await expect(
			runMemoryImport(["--directory", dir, "--manifest", manifest], {
				write: () => {},
			}),
		).rejects.toThrow("Selected notes changed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
