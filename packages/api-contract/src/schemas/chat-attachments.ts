import * as z from "zod";
import { TediMessageAttachmentSchema } from "./cognitive-runtime";

/** Bounded upload lane; chat frames carry only private references. */
export const CHAT_ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_COUNT = 5;
export const CHAT_ATTACHMENT_REF_PREFIX = "tedix-attachment:";
export const UploadHomeAttachmentInputSchema =
	TediMessageAttachmentSchema.extend({
		content: z
			.string()
			.min(1)
			.max(Math.ceil(CHAT_ATTACHMENT_MAX_BYTES / 3) * 4 + 128),
		fileName: z.string().min(1).max(255),
		mimeType: z.string().min(1).max(100),
		type: z.enum(["image", "file"]),
	});
