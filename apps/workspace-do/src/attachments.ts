import { z } from "zod";
import { officeExtractText } from "@tedix/api-contract/utils/office-file-blocks";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { WorkspaceDataPort } from "./data-port";
import {
	FILE_TEXT_INLINE_CHARS,
	FILE_TEXT_MIN_INLINE_CHARS,
	fileTextLines,
	fileTextUnavailable,
	readTextPart,
} from "./file-text";

const AttachmentsSchema = z
	.array(z.object({ outputId: z.string().min(1).max(200) }))
	.max(5);

const INLINE_BYTES = 8_000;

/** Only workspace-readable content may enter the shared conversation. */
export async function resolveAttachments(
	data: WorkspaceDataPort,
	input: unknown,
) {
	const requested = AttachmentsSchema.parse(input ?? []);
	if (requested.length === 0) return { attachments: [], context: "" };
	const visible = new Set(
		(await data.listOutputs({ status: "active" })).map((output) => output.id),
	);
	const attachments: Array<{
		outputId: string;
		title: string;
		revision: number;
		revisionId: string;
	}> = [];
	const contents: string[] = [];
	let bytes = 0;
	// Uploaded files share one text budget, so a message stays the size of a read.
	let fileChars = 0;
	for (const outputId of new Set(requested.map((item) => item.outputId))) {
		if (!visible.has(outputId))
			throw new Error(
				"An attachment is unavailable to this workspace. Remove it and try again.",
			);
		const output = await data.getOutput(outputId);
		if (!output?.content || !output.revisionId || output.status !== "active")
			throw new Error(
				"An attachment is unavailable to this workspace. Remove it and try again.",
			);
		const attachment = {
			outputId,
			title: output.title,
			revision: output.revision,
			revisionId: output.revisionId,
		};
		attachments.push(attachment);
		if (output.content.kind === "document" && output.content.file) {
			const stored = await data.readFileText(output.content.file);
			const room = FILE_TEXT_INLINE_CHARS - fileChars;
			const readOn = `env.outputs.readFileText({ outputId: "${outputId}", startLine })`;
			if (stored?.status === "text") {
				// A file that fits is given whole. A longer one gives its first
				// lines, as a first read would, and says how to read on.
				if (stored.text.length <= room) {
					fileChars += stored.text.length;
					contents.push(
						JSON.stringify({ ...attachment, fileText: stored.text }),
					);
					continue;
				}
				const lines = fileTextLines(stored.text);
				if (room < FILE_TEXT_MIN_INLINE_CHARS) {
					contents.push(
						JSON.stringify({
							...attachment,
							fileTextNote: `This file has ${lines.length} lines of text that are not shown here. Read them in parts with ${readOn}, starting at startLine 1.`,
						}),
					);
					continue;
				}
				const part = readTextPart(lines, {}, room);
				fileChars += part.text.length;
				contents.push(
					JSON.stringify({
						...attachment,
						fileText: part.text,
						fileTextNote:
							`${part.note ? `${part.note} ` : ""}These are lines 1 to ${part.endLine} of ${part.totalLines}; the rest is not shown here. ${part.nextStartLine ? `Read on with ${readOn}, from startLine ${part.nextStartLine}, or find lines with env.outputs.searchFileText.` : ""}`.trim(),
					}),
				);
				continue;
			}
			// An upload from before whole texts were kept still has its start.
			const start = stored
				? ""
				: officeExtractText(output.content.file.extract ?? []);
			if (start && room >= FILE_TEXT_MIN_INLINE_CHARS) {
				const fileText = start.slice(0, room);
				fileChars += fileText.length;
				contents.push(
					JSON.stringify({
						...attachment,
						fileText,
						fileTextNote: `This may be only the start of the file. ${fileTextUnavailable(null)}`,
					}),
				);
			} else if (stored || start)
				contents.push(
					JSON.stringify({
						...attachment,
						fileTextNote: fileTextUnavailable(stored),
					}),
				);
			else contents.push(JSON.stringify(attachment));
			continue;
		}
		const content = JSON.stringify({ ...attachment, content: output.content });
		const size = new TextEncoder().encode(content).byteLength;
		const inline =
			bytes + size <= INLINE_BYTES && output.content.kind !== "video";
		if (inline) {
			bytes += size;
			contents.push(content);
		} else {
			contents.push(JSON.stringify(attachment));
		}
	}
	return {
		attachments,
		context:
			"\n\nSelected workspace files:\n" +
			"Files without inline content can be read on demand with env.outputs.get(outputId) through run_code. This reads the current revision; check revisionId against the attached reference. An uploaded text, Markdown, JSON, code, spreadsheet, Word, PowerPoint or PDF file comes with its text as fileText: sheets are tables with spreadsheet column letters and row numbers. A long file shows only its first lines, and fileTextNote says which lines and how to read the rest in parts with env.outputs.readFileText; a fileTextNote without fileText says why the file has no text here. Other uploaded document and video bodies contain resource references, not file bytes.\n" +
			wrapUntrustedInput(contents.join("\n"), "workspace_files"),
	};
}
