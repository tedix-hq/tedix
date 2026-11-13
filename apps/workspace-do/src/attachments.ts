import { z } from "zod";
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
		const content = JSON.stringify({ ...attachment, content: output.content });
		const size = new TextEncoder().encode(content).byteLength;
		const inline =
			bytes + size <= INLINE_BYTES &&
			!(output.content.kind === "document" && output.content.file) &&
			output.content.kind !== "video";
		attachments.push(attachment);
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
			"Files without inline content can be read on demand with env.outputs.get(outputId) through run_code. This reads the current revision; check revisionId against the attached reference. Uploaded document and video bodies contain resource references, not file bytes.\n" +
			wrapUntrustedInput(contents.join("\n"), "workspace_files"),
	};
}
