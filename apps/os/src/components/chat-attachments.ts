/** Composer attachment typing, image-input refusal and file reading. */
import { File } from "@phosphor-icons/react";
import { prepareChatAttachment } from "@/lib/chat-attachment-upload";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type ModelImageInputSupport,
	resolveModelImageInput,
} from "@tedix/api-contract/schemas/model-catalog";
import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";

export type ComposerAttachment = TediMessageAttachment & {
	previewUrl: string | null;
};

export function attachmentType(file: File): TediMessageAttachment["type"] {
	return file.type.startsWith("image/") ? "image" : "file";
}

/**
 * Declared image-input capability of the model this composer would send to.
 *
 * The projection row wins (it is the org's own evaluated catalog), the static
 * catalog answers a ref the projection did not list, and anything else — no
 * selection yet, a custom or org-configured deployment, the deliberately
 * ungated env default — is `unknown`. `unknown` is never collapsed into a
 * verdict here; that is the whole point of the tri-state.
 */
export function selectedModelImageInput(
	models: readonly ModelCatalogModel[],
	selectedRef: string | null,
): ModelImageInputSupport {
	if (selectedRef === null) return "unknown";
	const listed = models.find((model) => model.ref === selectedRef);
	return listed ? listed.imageInput : resolveModelImageInput(selectedRef);
}

/**
 * Why this model must not be given an image, or null when it may be.
 *
 * `unknown` refuses. Attaching and hoping is the expensive failure: an image
 * the model rejects is part of the durable turn, so it replays on every
 * subsequent request in the conversation and wedges it permanently — there is
 * no client-side recovery from that, while a refused attachment costs one
 * sentence and a model switch.
 */
export function imageAttachmentRefusal(
	support: ModelImageInputSupport,
	modelLabel: string,
): string | null {
	if (support === "supported") return null;
	if (support === "unsupported") {
		return `${modelLabel} cannot read images: its serving path drops image attachments, so the file would never reach the model. Pick a vision-capable model, or send the file's contents as text.`;
	}
	return `${modelLabel} does not declare image support, so Tedix will not attach one: an image this model rejects stays in the turn and replays on every later message. Pick a model whose image support is declared.`;
}

/**
 * Why the composer will not take an image right now, or null when it will.
 *
 * Three states, not two. The gate is right to fail closed before a model is
 * resolved — the send would fall through to the server default (`modelRef:
 * undefined`), whose image support this client cannot read — but "the selected
 * model does not declare image support" is a FALSE sentence when nothing is
 * selected, and it is exactly the state the operator sees while the catalog
 * query is in flight and permanently if it fails or returns no allowed model.
 * So the no-selection states get their own copy, and a catalog still resolving
 * is told apart from one that resolved to nothing.
 */
export function composerImageRefusal(input: {
	models: readonly ModelCatalogModel[];
	selectedRef: string | null;
	modelLabel: string;
	/** The catalog query is in flight, or has landed but not yet been applied. */
	selectionPending: boolean;
}): string | null {
	if (input.selectedRef === null) {
		return input.selectionPending
			? "Tedix is still loading which models this workspace may use, so it cannot yet tell whether the model that would answer can read images. Send the message without the image, or try again in a moment."
			: "No model is resolved for this workspace, so the message would route to the server's default — whose image support Tedix cannot read here, and an image the model rejects stays in the turn and replays on every later message. Pick a model whose image support is declared, or send the file's contents as text.";
	}
	return imageAttachmentRefusal(
		selectedModelImageInput(input.models, input.selectedRef),
		input.modelLabel,
	);
}

export async function readComposerAttachment(
	file: File,
): Promise<ComposerAttachment> {
	const prepared = await prepareChatAttachment(file);
	const content = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error ?? new Error("Could not read attachment"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(prepared.blob);
	});
	return {
		content,
		fileName: file.name,
		mimeType: prepared.mimeType,
		size: prepared.blob.size,
		type: attachmentType(file),
		previewUrl: file.type.startsWith("image/") ? content : null,
	};
}
