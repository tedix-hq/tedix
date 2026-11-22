import { expect, test } from "bun:test";
import { resolveAttachments } from "./attachments";
import type { WorkspaceFileText } from "@tedix/api-contract/utils/workspace-file-text";
import type { OutputDetail, WorkspaceDataPort } from "./data-port";
import { FILE_TEXT_INLINE_CHARS } from "./file-text";

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

test("a chat upload supplies its private text without becoming a workspace output", async () => {
	const workspaceId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	const manifest = {
		organizationId: "org_test",
		workspaceId,
		resourceId,
		uploadId: "fixture",
		filename: "note.txt",
		mimeType: "text/plain",
		size: 4,
		createdByKind: "user" as const,
		createdById: "u1",
		createdAt: new Date().toISOString(),
		expiresAt: new Date().toISOString(),
		chatOnly: true,
		chatReady: true,
		mimeValidated: true,
	};
	const data = {
		listOutputs: () => {
			throw new Error("No shared workspace file should be read");
		},
		readFileText: async (file: { resourceId: string; chatOnly?: true }) => {
			expect(file).toEqual({ workspaceId, resourceId, chatOnly: true });
			return { status: "text", text: "note" };
		},
	} as unknown as WorkspaceDataPort;
	const { attachments, context } = await resolveAttachments(
		data,
		[{ outputId: resourceId, chatOnly: true }],
		undefined,
		async () => manifest,
	);
	expect(attachments).toEqual([
		{
			outputId: resourceId,
			title: "note.txt",
			revision: 1,
			revisionId: resourceId,
			chatOnly: true,
		},
	]);
	expect(context).toContain('"fileText":"note"');
});

function fileOutput(
	id: string,
	file: { resourceId: string; extract?: unknown[] },
): OutputDetail {
	return {
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
				...file,
			},
			blocks: [],
		},
	} as OutputDetail;
}

function attach(
	outputs: OutputDetail[],
	texts: Record<string, WorkspaceFileText>,
) {
	const data = {
		listOutputs: async () => outputs,
		getOutput: async (id: string) =>
			outputs.find((output) => output.id === id) ?? null,
		readFileText: async (file: { resourceId: string }) =>
			texts[file.resourceId] ?? null,
	} as WorkspaceDataPort;
	return resolveAttachments(
		data,
		outputs.map((output) => ({ outputId: output.id })),
	).then(({ context }) => ({
		context,
		entries: context
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line)),
	}));
}

test("a short uploaded file reaches the agent whole; a long one as its first lines with the way to read on", async () => {
	const budget =
		"## Budget\n\n| Row | A | B | C |\n| 1 | Item | Count | Price |\n| 2 | Paper | 2 | 3.5 |";
	const rows = Array.from(
		{ length: 4_000 },
		(_, index) => `| ${index + 1} | ledger entry | ${index * 3} |`,
	);
	rows.push("| 4001 | closing balance | 918273 |");
	const { context, entries } = await attach(
		[
			fileOutput("budget", { resourceId: "r-budget" }),
			fileOutput("ledger", { resourceId: "r-ledger" }),
			fileOutput("notes", { resourceId: "r-notes" }),
		],
		{
			"r-budget": { status: "text", text: budget },
			"r-ledger": { status: "text", text: rows.join("\n") },
			"r-notes": { status: "text", text: "n\n".repeat(900) },
		},
	);
	expect(entries[0].fileText).toBe(budget);
	expect(entries[0].fileTextNote).toBeUndefined();
	expect(entries[0].content).toBeUndefined();
	// The long file fills what is left of the shared budget with whole lines.
	const shown = entries[1].fileText.split("\n");
	expect(shown).toEqual(rows.slice(0, shown.length));
	expect(budget.length + entries[1].fileText.length).toBeLessThanOrEqual(
		FILE_TEXT_INLINE_CHARS,
	);
	expect(
		budget.length + entries[1].fileText.length + rows[shown.length]!.length,
	).toBeGreaterThanOrEqual(FILE_TEXT_INLINE_CHARS);
	expect(context).not.toContain("closing balance");
	expect(entries[1].fileTextNote).toBe(
		`These are lines 1 to ${shown.length} of 4001; the rest is not shown here. Read on with env.outputs.readFileText({ outputId: "ledger", startLine }), from startLine ${shown.length + 1}, or find lines with env.outputs.searchFileText.`,
	);
	// With the budget used up, a further file is named with its length only.
	expect(entries[2].fileText).toBeUndefined();
	expect(entries[2].fileTextNote).toContain(
		"This file has 900 lines of text that are not shown here.",
	);
	expect(context).toContain("env.outputs.readFileText");
});

test("a file without text says why, and an earlier upload keeps the start it was stored with", async () => {
	const { entries } = await attach(
		[
			fileOutput("scan", { resourceId: "r-scan" }),
			fileOutput("video", { resourceId: "r-video" }),
			fileOutput("earlier", {
				resourceId: "r-earlier",
				extract: [{ type: "paragraph", text: "Opening paragraph." }],
			}),
			fileOutput("plain", { resourceId: "r-plain" }),
		],
		{
			"r-scan": { status: "no_text", text: "" },
			"r-video": { status: "unsupported", text: "" },
		},
	);
	expect(entries[0].fileText).toBeUndefined();
	expect(entries[0].fileTextNote).toContain("This PDF has no readable text");
	expect(entries[1].fileTextNote).toContain("has no text to read here");
	expect(entries[2].fileText).toBe("Opening paragraph.");
	expect(entries[2].fileTextNote).toContain(
		"This may be only the start of the file.",
	);
	expect(entries[3]).toEqual({
		outputId: "plain",
		title: "plain.xlsx",
		revision: 1,
		revisionId: "rev-plain",
	});
});
