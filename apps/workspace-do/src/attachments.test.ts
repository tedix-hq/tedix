import { expect, test } from "bun:test";
import { resolveAttachments } from "./attachments";
import type { OutputDetail, WorkspaceDataPort } from "./data-port";

test("inline budget counts UTF-8 bytes across files and deduplicates references", async () => {
	const outputs: OutputDetail[] = ["first", "second", "large"].map((id) => ({
		id,
		title: id,
		kind: "document",
		status: "active",
		revision: 1,
		revisionId: `rev-${id}`,
		updatedAt: "",
		content: {
			kind: "document",
			blocks: [
				{
					type: "paragraph",
					text: id === "large" ? "x".repeat(68_000) : "😀".repeat(1000),
				},
			],
		},
	}));
	const reads: string[] = [];
	const data = {
		listOutputs: async () => outputs,
		getOutput: async (id: string) => {
			reads.push(id);
			return outputs.find((output) => output.id === id) ?? null;
		},
	} as WorkspaceDataPort;
	const { attachments, context } = await resolveAttachments(data, [
		{ outputId: "first" },
		{ outputId: "second" },
		{ outputId: "large" },
		{ outputId: "large" },
	]);
	expect(attachments).toHaveLength(3);
	expect(reads).toEqual(["first", "second", "large"]);
	const entries = context
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
	expect(entries[0].content.blocks[0].text).toBe("😀".repeat(1000));
	expect(entries[1].content).toBeUndefined();
	expect(entries[2]).toEqual({
		outputId: "large",
		title: "large",
		revision: 1,
		revisionId: "rev-large",
	});
	expect(context).not.toContain("x".repeat(100));
});

test("an uploaded spreadsheet reaches the agent as its cell text, within the file budget", async () => {
	const file = (id: string, rows: string[][]): OutputDetail => ({
		id,
		title: `${id}.xlsx`,
		kind: "document",
		status: "active",
		revision: 1,
		revisionId: `rev-${id}`,
		updatedAt: "",
		content: {
			kind: "document",
			file: {
				workspaceId: "10000000-0000-4000-8000-000000000001",
				resourceId: "10000000-0000-4000-8000-000000000002",
				extract: [
					{ type: "heading", level: 2, text: "Budget" },
					{ type: "table", headers: ["Row", "A", "B", "C"], rows },
				],
			},
			blocks: [],
		},
	});
	const outputs = [
		file("budget", [
			["1", "Item", "Count", "Price"],
			["2", "Paper", "2", "3.5"],
			["3", "Ink", "1", "10"],
		]),
		file("huge", [["1", "y".repeat(60_000), "", ""]]),
		{
			...file("pdf", []),
			content: {
				kind: "document" as const,
				file: {
					workspaceId: "10000000-0000-4000-8000-000000000001",
					resourceId: "10000000-0000-4000-8000-000000000003",
				},
				blocks: [],
			},
		},
	];
	const data = {
		listOutputs: async () => outputs,
		getOutput: async (id: string) =>
			outputs.find((output) => output.id === id) ?? null,
	} as WorkspaceDataPort;
	const { context } = await resolveAttachments(data, [
		{ outputId: "budget" },
		{ outputId: "huge" },
		{ outputId: "pdf" },
	]);
	const entries = context
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
	expect(entries[0].fileText).toBe(
		"## Budget\n\n| Row | A | B | C |\n| 1 | Item | Count | Price |\n| 2 | Paper | 2 | 3.5 |\n| 3 | Ink | 1 | 10 |",
	);
	expect(entries[0].content).toBeUndefined();
	expect(entries[1].fileText).toContain(
		'[Cut short to fit this message. Read the rest with env.outputs.get("huge").]',
	);
	expect(
		entries[0].fileText.length + entries[1].fileText.indexOf("\n\n[Cut short"),
	).toBe(50_000);
	expect(entries[2]).toEqual({
		outputId: "pdf",
		title: "pdf.xlsx",
		revision: 1,
		revisionId: "rev-pdf",
	});
	expect(context).toContain("column letters and row numbers");
});
