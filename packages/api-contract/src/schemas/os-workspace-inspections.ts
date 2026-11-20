import * as z from "zod";

/**
 * Read-only inspection of a workspace by an organization owner or admin.
 *
 * Starting an inspection writes one `os.workspace.inspected` audit row. That
 * row is the inspection: for the next hour its author may read the
 * workspace's files, app list, chat history and activity, and change nothing.
 */
export const OS_WORKSPACE_INSPECTION_ACTION = "os.workspace.inspected";

/** How long one recorded inspection lets its author read the workspace. */
export const OS_WORKSPACE_INSPECTION_MS = 60 * 60_000;

/**
 * Request header naming the workspace a browser is inspecting. It only says
 * which workspace the caller means; the server still requires a recorded
 * inspection and a read it allows.
 */
export const OS_WORKSPACE_INSPECTION_HEADER = "X-Tedix-Workspace-Inspection";

export const OsInspectableWorkspaceSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	visibility: z.enum(["org", "private"]),
	ownerName: z
		.string()
		.nullable()
		.describe("The owner of a private workspace, when known"),
});
export type OsInspectableWorkspace = z.infer<
	typeof OsInspectableWorkspaceSchema
>;

export const OsWorkspaceInspectionStartInputSchema = z
	.object({
		workspaceId: z.string().uuid(),
		reason: z
			.string()
			.trim()
			.max(500)
			.optional()
			.describe("Why the workspace is inspected; kept in the audit record"),
	})
	.strict();

export const OsWorkspaceInspectionStartSchema = z.object({
	workspaceId: z.string().uuid(),
	startedAt: z.string(),
	endsAt: z.string(),
});

export const OsWorkspaceInspectionRecordSchema = z.object({
	id: z.string(),
	at: z.string(),
	inspectorName: z.string().nullable(),
});
export type OsWorkspaceInspectionRecord = z.infer<
	typeof OsWorkspaceInspectionRecordSchema
>;
