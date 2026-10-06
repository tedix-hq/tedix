import type { SessionMessage } from "agents/sessions";
import type { PiSubmissionInspection } from "./pi-types";

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
	return message.parts
		.map((part) =>
			part.type === "text" && typeof part.text === "string" ? part.text : "",
		)
		.join("")
		.trim();
}
