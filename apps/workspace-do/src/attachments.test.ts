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
