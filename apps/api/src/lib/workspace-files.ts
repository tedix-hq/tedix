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
