import { z } from "zod";
import {
	OFFICE_EXTRACT_LIMITS,
	officeExtractText,
} from "@tedix/api-contract/utils/office-file-blocks";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { WorkspaceDataPort } from "./data-port";

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
	// Uploaded spreadsheets, Word and PowerPoint files share one text budget.
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
			const text = officeExtractText(output.content.file.extract ?? []);
			const room = OFFICE_EXTRACT_LIMITS.chars - fileChars;
			if (text && room > 0) {
				const fileText =
					text.length > room
						? `${text.slice(0, room)}\n\n[Cut short to fit this message. Read the rest with env.outputs.get("${outputId}").]`
						: text;
				fileChars += Math.min(text.length, room);
				contents.push(JSON.stringify({ ...attachment, fileText }));
			} else contents.push(JSON.stringify(attachment));
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
			"Files without inline content can be read on demand with env.outputs.get(outputId) through run_code. This reads the current revision; check revisionId against the attached reference. An uploaded spreadsheet, Word or PowerPoint file comes with its text as fileText: sheets are tables with spreadsheet column letters and row numbers, and long files show only their start. Other uploaded document and video bodies contain resource references, not file bytes.\n" +
			wrapUntrustedInput(contents.join("\n"), "workspace_files"),
	};
}
