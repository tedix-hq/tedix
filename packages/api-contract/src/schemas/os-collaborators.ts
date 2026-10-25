import * as z from "zod";

/**
 * Workspace collaborators. Roles are totally ordered: `build` > `use`.
 *
 * - `build`: everything the owner can do in the workspace except delete it.
 * - `use`: render and interact with the deployed apps, read id/title/owner/
 *   role metadata, and see who else is present. Nothing else.
 */
export const OsCollaboratorRoleSchema = z.enum(["use", "build"]);
export type OsCollaboratorRole = z.infer<typeof OsCollaboratorRoleSchema>;

export const OS_COLLABORATOR_ROLE_RANK: Record<OsCollaboratorRole, number> = {
	use: 1,
	build: 2,
};

export function minCollaboratorRole(
	a: OsCollaboratorRole,
	b: OsCollaboratorRole,
): OsCollaboratorRole {
	return OS_COLLABORATOR_ROLE_RANK[a] <= OS_COLLABORATOR_ROLE_RANK[b] ? a : b;
}

export function collaboratorRoleAtLeast(
	role: OsCollaboratorRole | null | undefined,
	required: OsCollaboratorRole,
): boolean {
	return (
		role != null &&
		OS_COLLABORATOR_ROLE_RANK[role] >= OS_COLLABORATOR_ROLE_RANK[required]
	);
}

/**
 * Every operation a workspace session can perform, with the lowest role
 * allowed to perform it. `satisfies Record<…>` makes a new operation fail to
 * compile until someone decides its role; unknown operation names are denied
 * at runtime (`operationAllowed`). Add an operation here before a runtime or
 * route exposes it.
 */
export const OS_WORKSPACE_OPERATION_ROLES = {
	// `use` allowlist: render and interact with the deployed app UI.
	"app.render": "use",
	"app.connect": "use",
	"metadata.read": "use",
	"presence.read": "use",
	// Everything else needs `build`.
	"app.edit": "build",
	"app.chat": "build",
	"app.runs.read": "build",
	"bindings.read": "build",
	"bindings.add": "build",
	"files.read": "build",
	"files.write": "build",
	"outputs.read": "build",
	"outputs.write": "build",
	"logs.read": "build",
	"sharing.read": "build",
	"sharing.write": "build",
} as const satisfies Record<string, OsCollaboratorRole>;

export type OsWorkspaceOperation = keyof typeof OS_WORKSPACE_OPERATION_ROLES;

export const OsWorkspaceOperationSchema = z.enum(
	Object.keys(OS_WORKSPACE_OPERATION_ROLES) as [
		OsWorkspaceOperation,
		...OsWorkspaceOperation[],
	],
);

/** Default deny: unknown operations and missing roles are never allowed. */
export function operationAllowed(
	role: OsCollaboratorRole | null | undefined,
	operation: string,
): boolean {
	if (!Object.hasOwn(OS_WORKSPACE_OPERATION_ROLES, operation)) return false;
	return collaboratorRoleAtLeast(
		role,
		OS_WORKSPACE_OPERATION_ROLES[operation as OsWorkspaceOperation],
	);
}

export function operationsForRole(
	role: OsCollaboratorRole,
): OsWorkspaceOperation[] {
	return (Object.keys(OS_WORKSPACE_OPERATION_ROLES) as OsWorkspaceOperation[])
		.filter((operation) => operationAllowed(role, operation))
		.sort();
}

/**
 * What `open` hands back: the caller's role, recomputed from the permission
 * graph on this open, and the operations that role may perform. A runtime
 * checks every call against `operations`; it never widens them.
 */
export const OsWorkspaceCapabilitySchema = z.object({
	workspaceId: z.string().uuid(),
	appId: z
		.string()
		.uuid()
		.nullable()
		.describe("The app this session opened, or null for the whole workspace"),
	role: OsCollaboratorRoleSchema,
	operations: z.array(OsWorkspaceOperationSchema),
	actingUserId: z
		.string()
		.describe(
			"The person this session acts as. AI models and connected accounts for anything they add resolve from this person, never from the owner",
		),
	openedAt: z.string(),
});
export type OsWorkspaceCapability = z.infer<typeof OsWorkspaceCapabilitySchema>;

export const OsCollaboratorPersonSchema = z.object({
	userId: z.string(),
	email: z.string().nullable(),
	name: z.string().nullable(),
});

export const OsAffectedCollaboratorSchema = OsCollaboratorPersonSchema.extend({
	oldRole: OsCollaboratorRoleSchema,
	newRole: OsCollaboratorRoleSchema.nullable().describe(
		"Role after the change; null means the person loses access",
	),
});
export type OsAffectedCollaborator = z.infer<
	typeof OsAffectedCollaboratorSchema
>;

export const OsCollaboratorSchema = OsCollaboratorPersonSchema.extend({
	role: OsCollaboratorRoleSchema,
	addedBy: z
		.array(z.string())
		.describe("Names of the people or links that granted access"),
	canRemove: z
		.boolean()
		.describe("Whether the caller may remove this person (or their own grant)"),
	lastOpenedAt: z.string().nullable(),
});
export type OsCollaborator = z.infer<typeof OsCollaboratorSchema>;

export const OsCollaboratorLinkSchema = z.object({
	id: z.string().uuid(),
	role: OsCollaboratorRoleSchema,
	label: z.string().nullable(),
	createdBy: OsCollaboratorPersonSchema,
	createdAt: z.string(),
	canRevoke: z.boolean(),
});
export type OsCollaboratorLink = z.infer<typeof OsCollaboratorLinkSchema>;

export const OsSharedWorkspaceSchema = z.object({
	workspaceId: z.string().uuid(),
	title: z.string(),
	ownerName: z.string().nullable(),
	firstOpenedAt: z.string(),
	lastOpenedAt: z.string(),
});
export type OsSharedWorkspace = z.infer<typeof OsSharedWorkspaceSchema>;

/** The removal target: one person, or one link. */
export const OsCollaboratorTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("user"), userId: z.string().min(1).max(200) }),
	z.object({ kind: z.literal("link"), linkId: z.string().uuid() }),
]);
export type OsCollaboratorTarget = z.infer<typeof OsCollaboratorTargetSchema>;
