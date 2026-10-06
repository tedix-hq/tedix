import { Buffer } from "node:buffer";
import type { ModelMessage } from "ai";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { TediSessionMessage } from "@tedix/tedi-session/session-harness";
import {
	CHAT_ATTACHMENT_MAX_BYTES,
	CHAT_ATTACHMENT_MAX_COUNT,
} from "@tedix/api-contract/schemas/chat-attachments";

export type HomeAttachmentResolver = (
	attachments: readonly TediMessageAttachment[],
) => Promise<TediMessageAttachment[] | undefined>;

/** Rebuild only the retained ledger slice, newest first for budget admission.
 * Bytes are request-local: checkpoints and the durable transcript keep references.
 */
export async function hydrateHomeHistory(
	history: readonly TediSessionMessage[],
	resolve?: HomeAttachmentResolver,
): Promise<TediSessionMessage[]> {
	let remainingFiles = CHAT_ATTACHMENT_MAX_COUNT;
	let remainingBytes = CHAT_ATTACHMENT_MAX_COUNT * CHAT_ATTACHMENT_MAX_BYTES;
	let remainingText = 16_384;
	const result: TediSessionMessage[] = [];
	for (const message of [...history].reverse()) {
		let content = message.content;
		const attachments: TediMessageAttachment[] = [];
		for (const attachment of message.role === "user"
			? (message.attachments ?? [])
			: []) {
			const omitted = (reason: string) => {
				content += `\n[Attachment ${JSON.stringify(attachment.fileName)} omitted: ${reason}.]`;
			};
			if (remainingFiles-- <= 0) {
				omitted("history replay limit reached");
				continue;
			}
			if (attachment.type === "audio") {
				omitted("audio replay is not supported; use the saved transcript");
				continue;
			}
			try {
				const resolved = (await resolve?.([attachment]))?.[0];
				if (!resolved) throw new Error("Attachment resolver unavailable");
				if ((resolved.size ?? 0) > remainingBytes) {
					omitted("history byte limit reached");
					continue;
				}
				remainingBytes -= resolved.size ?? 0;
				if (resolved.type === "image") attachments.push(resolved);
				else {
					const fileText = homeAttachmentContent("", [resolved]).text;
					if (!fileText) omitted("file type is not supported");
					else {
						content += fileText.slice(0, remainingText);
						if (fileText.length > remainingText)
							content +=
								"\n[Attachment text truncated by history replay limit.]";
						remainingText = Math.max(0, remainingText - fileText.length);
					}
				}
			} catch {
				console.warn("[kernel] historical attachment could not be loaded");
				omitted("stored content is unavailable or invalid");
			}
		}
		result.push({
			role: message.role,
			content,
			...(attachments.length ? { attachments } : {}),
		});
	}
	return result.reverse();
}

export function hasHomeHistoryImages(
	history: readonly TediSessionMessage[],
): boolean {
	return history.some(
		(message) =>
			message.role === "user" &&
			message.attachments?.some((attachment) => attachment.type === "image"),
	);
}

/** Attachment text is untrusted source material, never an instruction channel. */
export function homeAttachmentContent(
	text: string,
	attachments?: readonly TediMessageAttachment[],
) {
	const images: string[] = [];
	for (const attachment of attachments ?? []) {
		if (attachment.type === "image") images.push(attachment.content);
		else if (
			attachment.type === "file" &&
			/^data:(text\/[^;]+|application\/(json|xml|javascript));base64,/.test(
				attachment.content,
			)
		) {
			const encoded = attachment.content.slice(
				attachment.content.indexOf(",") + 1,
			);
			text += `\n\nAttached file (untrusted source): ${JSON.stringify(attachment.fileName)}\n${Buffer.from(encoded, "base64").toString("utf8")}\nEnd attached file.\n`;
		}
	}
	return { text, images };
}

/** Preserve the existing text-only request shape; images are native model parts. */
export function homeModelPrompt(
	text: string,
	images?: readonly string[],
	history: readonly TediSessionMessage[] = [],
): { prompt: string } | { messages: ModelMessage[] } {
	const replay: ModelMessage[] = hasHomeHistoryImages(history)
		? history.map((message): ModelMessage => {
				if (message.role === "assistant")
					return { role: "assistant", content: message.content };
				const projected = homeAttachmentContent(
					message.content,
					message.attachments,
				);
				return {
					role: "user",
					content: [
						{
							type: "text",
							text:
								projected.text ||
								"[Attached image — untrusted source material]",
						},
						...projected.images.map((data) => ({
							type: "file" as const,
							mediaType: "image",
							data,
						})),
					],
				};
			})
		: [];
	return images?.length || replay.length
		? {
				messages: [
					...replay,
					{
						role: "user",
						content: [
							{ type: "text", text },
							...(images ?? []).map((data) => ({
								type: "file" as const,
								mediaType: "image",
								data,
							})),
						],
					},
				],
			}
		: { prompt: text };
}
