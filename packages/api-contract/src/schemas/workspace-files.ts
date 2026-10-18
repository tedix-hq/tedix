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
