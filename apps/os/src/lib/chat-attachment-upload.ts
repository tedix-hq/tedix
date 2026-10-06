import {
	CHAT_ATTACHMENT_MAX_BYTES,
	CHAT_ATTACHMENT_MAX_COUNT,
	CHAT_ATTACHMENT_REF_PREFIX,
} from "@tedix/api-contract/schemas/chat-attachments";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";

/** Upload bytes over HTTP before enqueue; content-addressed handles make retries idempotent. */
export async function uploadChatAttachments(
	attachments: TediMessageAttachment[] | undefined,
	upload: (attachment: TediMessageAttachment) => Promise<TediMessageAttachment>,
) {
	if (!attachments?.length) return attachments;
	if (attachments.length > CHAT_ATTACHMENT_MAX_COUNT)
		throw new Error("Attach at most five files.");
	const total = attachments.reduce(
		(sum, attachment) => sum + (attachment.size ?? 0),
		0,
	);
	if (total > CHAT_ATTACHMENT_MAX_BYTES)
		throw new Error("Attachments must total at most 1 MiB per message.");
	return Promise.all(
		attachments.map((attachment) =>
			attachment.type === "audio" ||
			attachment.content.startsWith(CHAT_ATTACHMENT_REF_PREFIX)
				? attachment
				: upload(attachment),
		),
	);
}

/** Resize large screenshots before encoding; text is kept byte-for-byte. */
export async function prepareChatAttachment(
	file: File,
): Promise<{ blob: Blob; mimeType: string }> {
	const mimeType =
		file.type ||
		(/\.(txt|md|csv|log|ts|tsx|js|py|html|css)$/i.test(file.name)
			? "text/plain"
			: /\.json$/i.test(file.name)
				? "application/json"
				: "application/octet-stream");
	if (!mimeType.startsWith("image/")) {
		if (
			!mimeType.startsWith("text/") &&
			![
				"application/json",
				"application/xml",
				"application/javascript",
			].includes(mimeType)
		)
			throw new Error(
				"Attach a PNG, JPEG, WebP, or UTF-8 text file. PDF and other binary formats are not supported yet.",
			);
		if (file.size > CHAT_ATTACHMENT_MAX_BYTES)
			throw new Error("Attachments must be at most 1 MiB.");
		return { blob: file, mimeType };
	}
	if (file.size > 25 * CHAT_ATTACHMENT_MAX_BYTES)
		throw new Error("Images must be at most 25 MiB before resizing.");
	if (
		["image/png", "image/jpeg", "image/webp"].includes(mimeType) &&
		file.size <= CHAT_ATTACHMENT_MAX_BYTES
	)
		return { blob: file, mimeType };
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not prepare the image.");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(value) =>
					value ? resolve(value) : reject(new Error("Could not encode image.")),
				"image/webp",
				0.85,
			),
		);
		if (blob.size > CHAT_ATTACHMENT_MAX_BYTES)
			throw new Error(
				"Image is still larger than 1 MiB after resizing. Choose a smaller image.",
			);
		return { blob, mimeType: blob.type };
	} finally {
		bitmap.close();
	}
}
