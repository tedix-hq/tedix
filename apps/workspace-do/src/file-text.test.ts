import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import type { WorkspaceFileText } from "@tedix/api-contract/utils/workspace-file-text";
import { SqlComplianceAdapter } from "./adapters";
import { buildWorkspaceBindings } from "./bindings";
import type { OutputDetail, WorkspaceDataPort } from "./data-port";
import {
	FILE_TEXT_PART_CHARS,
	FILE_TEXT_SEARCH_LINE_CHARS,
	FILE_TEXT_SEARCH_MATCHES,
	encodedLength,
	fileTextLines,
	fileTextUnavailable,
	readTextPart,
	searchTextLines,
} from "./file-text";
import type { WorkspaceStorage } from "./runtime";
import { MAX_TOOL_RESULT_CHARS } from "./turn-loop";

describe("reading a file's text in parts", () => {
	test("a final line break does not start another line", () => {
		expect(fileTextLines("a\nb\n")).toEqual(["a", "b"]);
		expect(fileTextLines("a\n\nb")).toEqual(["a", "", "b"]);
		expect(fileTextLines("")).toEqual([]);
	});

	test("a part holds whole lines up to the size limit and says where to continue", () => {
		const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		// "line 1" to "line 3" joined by line breaks are 20 characters.
		expect(readTextPart(lines, {}, 20)).toEqual({
			text: "line 1\nline 2\nline 3",
			startLine: 1,
			endLine: 3,
			totalLines: 10,
			nextStartLine: 4,
		});
		// One character less and the third line no longer fits whole.
		expect(readTextPart(lines, {}, 19)).toMatchObject({
			endLine: 2,
			nextStartLine: 3,
		});
	});

	test("following nextStartLine reads every line once, to the end", () => {
		const lines = Array.from(
			{ length: 500 },
			(_, index) => `row ${index + 1} ${"x".repeat(index % 40)}`,
		);
		const seen: string[] = [];
		let startLine: number | null = 1;
		let reads = 0;
		while (startLine !== null) {
			const part = readTextPart(lines, { startLine }, 1_000);
			expect(part.text.length).toBeLessThanOrEqual(1_000);
			expect(part.startLine).toBe(startLine);
			seen.push(...part.text.split("\n"));
			startLine = part.nextStartLine;
			reads += 1;
		}
		expect(seen).toEqual(lines);
		expect(reads).toBeGreaterThan(5);
	});

	test("lineCount is an upper bound and the last part ends the file", () => {
		const lines = ["a", "b", "c", "d"];
		expect(readTextPart(lines, { startLine: 2, lineCount: 2 }, 100)).toEqual({
			text: "b\nc",
			startLine: 2,
			endLine: 3,
			totalLines: 4,
			nextStartLine: 4,
		});
		expect(
			readTextPart(lines, { startLine: 4, lineCount: 50 }, 100),
		).toMatchObject({ text: "d", endLine: 4, nextStartLine: null });
	});

	test("a start past the end is an error that names the file's length", () => {
		expect(() => readTextPart(["a", "b"], { startLine: 3 }, 100)).toThrow(
			"startLine 3 is past the end of the file, which has 2 lines.",
		);
		expect(() => readTextPart(["a"], { startLine: 0 }, 100)).toThrow(
			"startLine must be a whole number from 1",
		);
		expect(() => readTextPart(["a"], { lineCount: 1.5 }, 100)).toThrow(
			"lineCount must be a whole number from 1",
		);
		expect(readTextPart([], {}, 100)).toMatchObject({
			text: "",
			totalLines: 0,
			nextStartLine: null,
		});
	});

	test("a line too long to show whole is cut, with a note giving its length", () => {
		const part = readTextPart(["x".repeat(250), "next"], {}, 100);
		expect(part.text).toBe("x".repeat(100));
		expect(part.note).toBe(
			"Line 1 is 250 characters long; only its first 100 are shown.",
		);
		expect(part).toMatchObject({ endLine: 1, nextStartLine: 2 });
		// A character made of two code units is never split.
		const emoji = readTextPart(["😀".repeat(60)], {}, 101);
		expect(emoji.text).toBe("😀".repeat(50));
	});

	test("the tool's limit counts text as the tool result writes it", () => {
		// Every quote and line break takes two characters in a JSON result.
		const lines = Array.from({ length: 20_000 }, () => '"q"');
		const part = readTextPart(lines, {}, FILE_TEXT_PART_CHARS, encodedLength);
		expect(part.endLine).toBe(FILE_TEXT_PART_CHARS / 7);
		expect(JSON.stringify({ result: part, logs: [] }).length).toBeLessThan(
			MAX_TOOL_RESULT_CHARS,
		);
	});
});

describe("searching a file's text", () => {
	test("finds lines ignoring case and shows the text around each match", () => {
		const lines = [
			"Intro",
			`${"a".repeat(500)} Termination Fee ${"b".repeat(500)}`,
			"The termination fee is 4,200 EUR.",
		];
		const found = searchTextLines(lines, { query: "termination fee" });
		expect(found.matches.map((match) => match.line)).toEqual([2, 3]);
		expect(found.matches[0]!.text).toContain("Termination Fee");
		expect(found.matches[0]!.text.length).toBe(FILE_TEXT_SEARCH_LINE_CHARS + 2);
		expect(found.matches[1]!.text).toBe("The termination fee is 4,200 EUR.");
		expect(found).toMatchObject({ totalLines: 3, nextStartLine: null });
	});

	test("stops at the match limit and says where to search on", () => {
		const lines = Array.from({ length: 250 }, () => "hit");
		const first = searchTextLines(lines, { query: "hit" });
		expect(first.matches).toHaveLength(FILE_TEXT_SEARCH_MATCHES);
		expect(first.nextStartLine).toBe(FILE_TEXT_SEARCH_MATCHES + 1);
		const last = searchTextLines(lines, { query: "hit", startLine: 201 });
		expect(last.matches).toHaveLength(50);
		expect(last.nextStartLine).toBeNull();
		expect(() => searchTextLines(lines, { query: " " })).toThrow(
			"A search needs text",
		);
	});
});

describe("the agent's file reads", () => {
	const fileOutput = (id: string): OutputDetail => ({
		id,
		title: `${id}.pdf`,
		kind: "document",
		status: "active",
		revision: 1,
		revisionId: `rev-${id}`,
		updatedAt: "",
		content: {
			kind: "document",
			blocks: [],
			file: {
				workspaceId: "10000000-0000-4000-8000-000000000001",
				resourceId: id,
			},
		},
	});
	const long = Array.from(
		{ length: 3_000 },
		(_, index) => `Clause ${index + 1}: nothing of note.`,
	);
	long.push("Clause 3001: the renewal date is 14 March 2031.");
	const texts: Record<string, WorkspaceFileText> = {
		long: { status: "text", text: long.join("\n") },
		scan: { status: "no_text", text: "" },
		notes: {
			status: "text",
			text: Array.from(
				{ length: 2_000 },
				(_, index) => `- Step ${index + 1} of the runbook`,
			).join("\n"),
		},
		binary: { status: "unsupported", text: "" },
	};
	const outputs: OutputDetail[] = [
		fileOutput("long"),
		fileOutput("scan"),
		{ ...fileOutput("notes"), title: "Runbook.md" },
		{ ...fileOutput("binary"), title: "photo.txt" },
		fileOutput("old"),
		{
			...fileOutput("native"),
			content: { kind: "document", blocks: [] },
		},
	];
	function bindings() {
		const adapters = createInMemoryAdapters();
		// The workspace's own rule: writes by the agent wait for a person.
		const compliance = new SqlComplianceAdapter(
			{ run: () => {}, exec: () => [] } as unknown as WorkspaceStorage,
			{ writesNeedApproval: true },
		);
		const env = buildWorkspaceBindings({
			data: {
				getOutput: async (id: string) =>
					outputs.find((output) => output.id === id) ?? null,
				readFileText: async (file: { resourceId: string }) =>
					texts[file.resourceId] ?? null,
			} as WorkspaceDataPort,
			...adapters,
			compliance,
			actor: { id: "agent", kind: "tedi", organizationId: "o" },
			source: { surface: "workspace_object", traceId: "t" },
		});
		return {
			adapters,
			outputs: env.outputs as {
				readFileText(input: unknown): Promise<Record<string, unknown>>;
				searchFileText(input: unknown): Promise<Record<string, unknown>>;
				revise(input: unknown): Promise<unknown>;
			},
		};
	}

	test("text at the end of a long file is reached by reading on", async () => {
		const { outputs: files, adapters } = bindings();
		const first = await files.readFileText({ outputId: "long" });
		expect(first).toMatchObject({
			readable: true,
			outputId: "long",
			startLine: 1,
			totalLines: 3_001,
		});
		expect(String(first.text)).not.toContain("renewal date");
		expect(JSON.stringify({ result: first, logs: [] }).length).toBeLessThan(
			MAX_TOOL_RESULT_CHARS,
		);
		let part = first;
		let reads = 1;
		while (part.nextStartLine !== null) {
			part = await files.readFileText({
				outputId: "long",
				startLine: part.nextStartLine,
			});
			reads += 1;
		}
		expect(reads).toBeGreaterThan(1);
		expect(String(part.text)).toContain("the renewal date is 14 March 2031");
		expect(part.endLine).toBe(3_001);
		const found = await files.searchFileText({
			outputId: "long",
			query: "RENEWAL DATE",
		});
		expect(found.matches).toEqual([
			{ line: 3_001, text: "Clause 3001: the renewal date is 14 March 2031." },
		]);
		const records = await adapters.accountability.list();
		expect(records.length).toBe(reads + 1);
		expect(
			records.every(
				(record) =>
					record.decision.riskTier === "read" && record.outcome === "applied",
			),
		).toBe(true);
	});

	test("a 2,000-line Markdown file is read to its last line", async () => {
		const { outputs: files } = bindings();
		let part = await files.readFileText({ outputId: "notes" });
		expect(part).toMatchObject({ readable: true, title: "Runbook.md" });
		expect(part.totalLines).toBe(2_000);
		const seen = String(part.text).split("\n");
		while (part.nextStartLine !== null) {
			part = await files.readFileText({
				outputId: "notes",
				startLine: part.nextStartLine,
			});
			seen.push(...String(part.text).split("\n"));
		}
		expect(seen).toHaveLength(2_000);
		expect(seen.at(-1)).toBe("- Step 2000 of the runbook");
		expect(
			(await files.searchFileText({ outputId: "notes", query: "step 2000 " }))
				.matches,
		).toEqual([{ line: 2_000, text: "- Step 2000 of the runbook" }]);
	});

	test("a binary file named as text says it has no text", async () => {
		const { outputs: files } = bindings();
		const read = await files.readFileText({ outputId: "binary" });
		expect(read).toMatchObject({ readable: false, title: "photo.txt" });
		expect(String(read.reason)).toContain("This file has no text to read here");
		expect(String(read.reason)).toContain("Markdown");
	});

	test("a read never waits for approval, even where writes do", async () => {
		const { outputs: files } = bindings();
		await expect(
			files.revise({
				outputId: "native",
				expectedRevision: 1,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toThrow("Approval required");
		expect(
			await files.readFileText({ outputId: "long", lineCount: 1 }),
		).toMatchObject({ readable: true, text: "Clause 1: nothing of note." });
		expect(
			await files.searchFileText({ outputId: "long", query: "clause 2:" }),
		).toMatchObject({ readable: true });
	});

	test("a file without text says why instead of returning nothing", async () => {
		const { outputs: files } = bindings();
		expect(await files.readFileText({ outputId: "scan" })).toEqual({
			readable: false,
			outputId: "scan",
			title: "scan.pdf",
			reason: fileTextUnavailable({ status: "no_text", text: "" }),
		});
		expect(fileTextUnavailable({ status: "no_text", text: "" })).toContain(
			"This PDF has no readable text",
		);
		expect(await files.searchFileText({ outputId: "old", query: "x" })).toEqual(
			{
				readable: false,
				outputId: "old",
				title: "old.pdf",
				reason: fileTextUnavailable(null),
			},
		);
		for (const status of [
			"unsupported",
			"too_large",
			"failed",
			"not_allowed",
		] as const)
			expect(fileTextUnavailable({ status, text: "" })).not.toBe(
				fileTextUnavailable(null),
			);
		await expect(files.readFileText({ outputId: "native" })).rejects.toThrow(
			"This is not an uploaded file",
		);
		await expect(files.readFileText({ outputId: "missing" })).rejects.toThrow(
			"File not found or unavailable",
		);
	});
});
