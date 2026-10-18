import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import {
	WORKSPACE_FILE_PART_BYTES,
	WorkspaceFileMetadataSchema,
} from "@tedix/api-contract/schemas/workspace-files";
import * as z from "zod";

export const WorkspaceFileManifestSchema = WorkspaceFileMetadataSchema.extend({
	organizationId: z.string().min(1),
	workspaceId: z.uuid(),
	resourceId: z.uuid(),
	uploadId: z.string().min(1),
	createdByKind: z.enum(["user", "tedi", "external_agent", "service"]),
	createdById: z.string().min(1),
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	mimeValidated: z.boolean().optional(),
});
export type WorkspaceFileManifest = z.infer<typeof WorkspaceFileManifestSchema>;
export function workspaceFileKey(
	org: string,
	workspace: string,
	resource: string,
) {
	return `workspace-files/${encodeURIComponent(org)}/${workspace}/${resource}`;
}
export async function readWorkspaceFileManifest(
	env: CloudflareEnv,
	org: string,
	workspace: string,
	resource: string,
) {
	const object = await env.SKILL_ARTIFACTS.get(
		`${workspaceFileKey(org, workspace, resource)}.json`,
	);
	if (!object) return null;
	const manifest = WorkspaceFileManifestSchema.parse(await object.json());
	if (
		manifest.organizationId !== org ||
		manifest.workspaceId !== workspace ||
		manifest.resourceId !== resource
	)
		return null;
	return manifest;
}
export async function workspaceFileSignature(
	secret: string,
	action: string,
	org: string,
	workspace: string,
	resource: string,
	exp: number,
) {
	const key = await deriveHkdfHmacKey(secret, "tedix-workspace-file:v1");
	return base64UrlEncode(
		await hmacSha256(
			key,
			JSON.stringify([action, org, workspace, resource, exp]),
		),
	);
}
export async function verifyWorkspaceFileSignature(
	secret: string,
	action: string,
	org: string,
	workspace: string,
	resource: string,
	url: URL,
) {
	const exp = Number(url.searchParams.get("exp"));
	if (
		!Number.isSafeInteger(exp) ||
		exp * 1000 <= Date.now() ||
		exp * 1000 > Date.now() + 900_000
	)
		return false;
	const expected = await workspaceFileSignature(
		secret,
		action,
		org,
		workspace,
		resource,
		exp,
	);
	const sig = url.searchParams.get("sig") ?? "";
	if (sig.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < sig.length; i++)
		diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}
export function workspaceFilePartSize(size: number, part: number) {
	const count = Math.ceil(size / WORKSPACE_FILE_PART_BYTES);
	return Number.isInteger(part) && part >= 1 && part <= count
		? Math.min(
				WORKSPACE_FILE_PART_BYTES,
				size - (part - 1) * WORKSPACE_FILE_PART_BYTES,
			)
		: null;
}
/** Active content is download-only, even when the uploaded MIME claims otherwise. */
export function workspaceFileInlineMime(mime: string) {
	return [
		"video/mp4",
		"video/webm",
		"video/quicktime",
		"application/pdf",
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif",
		"image/avif",
	].includes(mime)
		? mime
		: null;
}

/** Check only the bounded prefix; unknown or truncated signatures fail closed. */
export function workspaceFileMimeMatches(mime: string, bytes: Uint8Array) {
	const matches = (signature: number[], offset = 0) =>
		signature.every((byte, index) => bytes[offset + index] === byte);
	const text = (offset: number, length: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + length));
	switch (mime) {
		case "application/pdf":
			return text(0, 5) === "%PDF-";
		case "image/png":
			return matches([137, 80, 78, 71, 13, 10, 26, 10]);
		case "image/jpeg":
			return matches([255, 216, 255]);
		case "image/gif":
			return ["GIF87a", "GIF89a"].includes(text(0, 6));
		case "image/webp":
			return text(0, 4) === "RIFF" && text(8, 4) === "WEBP";
		case "video/webm":
			return (
				matches([26, 69, 223, 163]) &&
				bytes.some((_, index) =>
					matches([66, 130, 132, 119, 101, 98, 109], index),
				)
			);
		case "video/mp4":
		case "video/quicktime":
		case "image/avif": {
			if (bytes.length < 16 || text(4, 4) !== "ftyp") return false;
			const size = new DataView(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			).getUint32(0);
			if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
			const brand = text(8, 4);
			if (mime === "video/quicktime") return brand === "qt  ";
			if (mime === "image/avif") return ["avif", "avis"].includes(brand);
			return ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(
				brand,
			);
		}
		default:
			return false;
	}
}
