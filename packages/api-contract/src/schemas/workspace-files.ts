import * as z from "zod";

export const WORKSPACE_FILE_MAX_BYTES = 200 * 1024 * 1024;
export const WORKSPACE_FILE_PART_BYTES = 8 * 1024 * 1024;
export const WorkspaceFileReferenceSchema = z.object({
	workspaceId: z.uuid(),
	resourceId: z.uuid(),
});
export const WorkspaceFileMetadataSchema = z.object({
	filename: z
		.string()
		.overwrite(
			(name) =>
				name
					.replace(/[\x00-\x1f\x7f-\x9f/\\]/g, "")
					.trim()
					.slice(0, 255)
					.replace(/[\uD800-\uDBFF]$/, "") || "file",
		)
		.trim()
		.min(1)
		.max(255)
		.regex(/^[^\x00-\x1f\x7f/\\]+$/),
	mimeType: z
		.string()
		.max(127)
		.regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
	size: z.number().int().min(1).max(WORKSPACE_FILE_MAX_BYTES),
});
export const WorkspaceFilePartSchema = z.object({
	partNumber: z.number().int().min(1).max(25),
	etag: z.string().min(1).max(200),
});

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
