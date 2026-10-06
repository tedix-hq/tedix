import { Buffer } from "node:buffer";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import { TediMessageAttachmentSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	CHAT_ATTACHMENT_MAX_BYTES,
	CHAT_ATTACHMENT_MAX_COUNT,
	CHAT_ATTACHMENT_REF_PREFIX,
	UploadHomeAttachmentInputSchema,
} from "@tedix/api-contract/schemas/chat-attachments";
import { ErrorCodes, createError } from "../../orpc";

const imageSignatures: Record<string, readonly number[]> = {
	"image/png": [137, 80, 78, 71, 13, 10, 26, 10],
	"image/jpeg": [255, 216, 255],
	"image/webp": [82, 73, 70, 70],
};
export function validateHomeAttachment(
	input: TediMessageAttachment,
): TediMessageAttachment {
	const attachment = UploadHomeAttachmentInputSchema.parse(input);
	const mimeType = (attachment.mimeType.split(";", 1)[0] ?? "")
		.trim()
		.toLowerCase();
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
		attachment.content,
	);
	if (
		!match?.[1] ||
		!match[2] ||
		match[1].toLowerCase() !== mimeType ||
		match[2].length % 4 !== 0
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Attachment must contain valid base64 data matching its MIME type",
		);
	const bytes = Buffer.from(match[2], "base64");
	if (!bytes.length || bytes.length > CHAT_ATTACHMENT_MAX_BYTES)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Attachments must be nonempty and at most 1 MiB",
		);
	if (attachment.type === "image") {
		const signature = imageSignatures[mimeType];
		if (
			!signature ||
			!signature.every((byte, i) => bytes[i] === byte) ||
			(mimeType === "image/webp" && bytes.subarray(8, 12).toString() !== "WEBP")
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Use a valid PNG, JPEG, or WebP image",
			);
	} else {
		if (
			!mimeType.startsWith("text/") &&
			![
				"application/json",
				"application/xml",
				"application/javascript",
			].includes(mimeType)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This chat supports images and UTF-8 text files. PDF and other binary formats are not supported yet.",
			);
		try {
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		} catch {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Text attachments must be valid UTF-8",
			);
		}
	}
	return {
		...attachment,
		mimeType,
		size: bytes.length,
		fileName: attachment.fileName.replace(/[\r\n]/g, " "),
		content: `data:${mimeType};base64,${bytes.toString("base64")}`,
	};
}

function key(orgId: string, ref: string): string {
	const digest = ref.slice(CHAT_ATTACHMENT_REF_PREFIX.length);
	if (
		!ref.startsWith(CHAT_ATTACHMENT_REF_PREFIX) ||
		!/^[a-f0-9]{64}$/.test(digest)
	)
		throw createError(ErrorCodes.BAD_REQUEST, "Invalid attachment reference");
	return `private/chat-attachments/${orgId}/${digest}.json`;
}

/** Immutable, organization-scoped objects; references are never public URLs. */
export async function storeHomeAttachment(
	bucket: R2Bucket,
	orgId: string,
	input: TediMessageAttachment,
): Promise<TediMessageAttachment> {
	const attachment = validateHomeAttachment(input);
	const body = JSON.stringify(attachment);
	const digest = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
	).toString("hex");
	const content = `${CHAT_ATTACHMENT_REF_PREFIX}${digest}`;
	await bucket.put(key(orgId, content), body, {
		httpMetadata: { contentType: "application/json" },
	});
	return { ...attachment, content };
}

/** Resolve only within the authenticated organization; never fetch client URLs. */
export async function resolveHomeAttachments(
	bucket: R2Bucket,
	orgId: string,
	attachments?: readonly TediMessageAttachment[],
): Promise<TediMessageAttachment[] | undefined> {
	if (!attachments?.length) return undefined;
	if (attachments.length > CHAT_ATTACHMENT_MAX_COUNT)
		throw createError(ErrorCodes.BAD_REQUEST, "Attach at most five files");
	const result: TediMessageAttachment[] = [];
	let total = 0;
	for (const attachment of attachments) {
		let resolved =
			attachment.type === "audio" ||
			attachment.content.startsWith(CHAT_ATTACHMENT_REF_PREFIX)
				? attachment
				: validateHomeAttachment(attachment);
		if (attachment.content.startsWith(CHAT_ATTACHMENT_REF_PREFIX)) {
			const object = await bucket.get(key(orgId, attachment.content));
			if (!object)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Attachment not found in this organization",
				);
			if (object.size > 2 * CHAT_ATTACHMENT_MAX_BYTES)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Attachment exceeds storage limit",
				);
			resolved = validateHomeAttachment(
				TediMessageAttachmentSchema.parse(await object.json()),
			);
		}
		total += resolved.size ?? 0;
		if (total > CHAT_ATTACHMENT_MAX_BYTES)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Attachments must total at most 1 MiB per message",
			);
		result.push(resolved);
	}
	return result;
}
