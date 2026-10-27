import type { SessionMessage } from "agents/sessions";
import type { PiSubmissionInspection } from "./pi-types";

/** Text parts are complete blocks, not token deltas. Keep their boundaries. */
export function assistantMessageText(parts: SessionMessage["parts"]): string {
	let text = "";
	for (const part of parts) {
		if (part.type !== "text" || !part.text?.trim()) continue;
		if (text && !/\s$/.test(text) && !/^\s/.test(part.text)) text += "\n\n";
		text += part.text;
	}
	return text.trim();
}

/** A terminal native receipt never falls back to another turn's assistant. */
export function submissionAssistantText(
	submission:
		| (Omit<PiSubmissionInspection, "status"> & { status: string })
		| null,
	message: SessionMessage | null,
): string {
	if (!submission) throw new Error("Facet submission not found");
	if (submission.status !== "completed")
		throw new Error(
			`Facet submission ${submission.status}: ${submission.error ?? submission.submissionId}`,
		);
	if (
		!submission.messageId ||
		!message ||
		message.id !== submission.messageId ||
		message.role !== "assistant"
	)
		throw new Error("Facet submission has no owned assistant message");
	return assistantMessageText(message.parts);
}
