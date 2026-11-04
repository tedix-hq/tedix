import { Buffer } from "node:buffer";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import { CHAT_ATTACHMENT_MAX_BYTES } from "@tedix/api-contract/schemas/chat-attachments";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import {
	readWorkspaceFileManifest,
	workspaceFileKey,
} from "../../../lib/workspace-files";
import { validateHomeAttachment } from "./attachment-storage";

export interface WorkspaceFileSource {
	bucket: R2Bucket;
	getResource(params: {
		organizationId: string;
		workspaceId: string;
		resourceId: string;
	}): Promise<OsWorkspaceResourceRow | undefined>;
}

const OUTPUT_LINK =
	/\/outputs\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?![\w-])/gi;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TEXT_TYPE = /^(?:text\/[\w.+-]+|application\/(?:json|xml|javascript))$/;

/**
 * Home's composer links an uploaded workspace file as an OS page URL
 * (`Workspace file: name (https://…/outputs/<id>)`), which needs a signed-in
 * browser. A delegated tedi gets the bytes instead: images as native image
 * parts, UTF-8 text inline. Only files of the Home run's own workspace
 * resolve; anything else stays a plain link.
 */
export async function workspaceFileAttachments(input: {
	source: WorkspaceFileSource;
	organizationId: string;
	workspaceId: string;
	content: string;
	limit: number;
}): Promise<{ attachments: TediMessageAttachment[]; notes: string[] }> {
	const attachments: TediMessageAttachment[] = [];
	const notes: string[] = [];
	const ids = [
		...new Set(
			[...input.content.matchAll(OUTPUT_LINK)].map((m) => m[1]!.toLowerCase()),
		),
	];
	for (const resourceId of ids) {
		const scope = {
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			resourceId,
		};
		const resource = await input.source.getResource(scope);
		if (
			!resource ||
			resource.status !== "active" ||
			resource.providerId !== "tedix" ||
			resource.resourceType !== "file"
		)
			continue;
		const omitted = (reason: string) =>
			notes.push(
				`[Workspace file ${JSON.stringify(resource.name)} not attached: ${reason}.]`,
			);
		if (attachments.length >= input.limit) {
			omitted("attachment limit reached");
			continue;
		}
		const manifest = await readWorkspaceFileManifest(
			{ SKILL_ARTIFACTS: input.source.bucket },
			scope.organizationId,
			scope.workspaceId,
			resourceId,
		);
		const mimeType = manifest?.mimeValidated ? manifest.mimeType : null;
		const type = !mimeType
			? null
			: IMAGE_TYPES.has(mimeType)
				? ("image" as const)
				: TEXT_TYPE.test(mimeType)
					? ("file" as const)
					: null;
		if (!manifest || !mimeType || !type) {
			omitted("only PNG, JPEG, WebP and UTF-8 text files are attached");
			continue;
		}
		if (manifest.size > CHAT_ATTACHMENT_MAX_BYTES) {
			omitted("larger than 1 MiB");
			continue;
		}
		const object = await input.source.bucket.get(
			workspaceFileKey(scope.organizationId, scope.workspaceId, resourceId),
		);
		if (!object) {
			omitted("stored file is unavailable");
			continue;
		}
		try {
			attachments.push(
				validateHomeAttachment({
					type,
					fileName: manifest.filename,
					mimeType,
					content: `data:${mimeType};base64,${Buffer.from(await object.arrayBuffer()).toString("base64")}`,
				}),
			);
		} catch {
			omitted("stored content is invalid");
		}
	}
	return { attachments, notes };
}
