import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	notInArray,
	or,
	type SQL,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	type NewOsWorkspaceRow,
	type OsWorkspaceRow,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { userConfigs } from "../../schema/user-configs";

export interface OsWorkspaceScopeParams {
	organizationId: string;
	workspaceId: string;
}

/**
 * The member a read is made for. A private workspace is visible only when its
 * `owner_user_id` is one of `userIds`, or when its id is one of
 * `workspaceIds` (a scheduled skill run reaching the workspace its skill is
 * linked to); an empty viewer sees org workspaces only. There is deliberately
 * no role-based bypass.
 */
export interface OsWorkspaceViewer {
	userIds: readonly string[];
	workspaceIds?: readonly string[];
}

export function isOsWorkspaceVisibleTo(
	workspace: Pick<OsWorkspaceRow, "id" | "visibility" | "ownerUserId">,
	viewer: OsWorkspaceViewer,
): boolean {
	if (workspace.visibility !== "private") return true;
	if (viewer.workspaceIds?.includes(workspace.id)) return true;
	return (
		workspace.ownerUserId !== null &&
		viewer.userIds.includes(workspace.ownerUserId)
	);
}

/** SQL twin of `isOsWorkspaceVisibleTo` over `os_workspaces`. */
export function osWorkspaceVisibleToPredicate(viewer: OsWorkspaceViewer): SQL {
	const userIds = [...new Set(viewer.userIds)];
	const workspaceIds = [...new Set(viewer.workspaceIds ?? [])];
	return or(
		eq(osWorkspaces.visibility, "org"),
		userIds.length ? inArray(osWorkspaces.ownerUserId, userIds) : undefined,
		workspaceIds.length ? inArray(osWorkspaces.id, workspaceIds) : undefined,
	) as SQL;
}

/**
 * Predicate on a `workspace_id` column (outputs and other workspace children):
 * true unless the row belongs to a private workspace the viewer cannot see.
 * Rows without a workspace stay visible.
 */
export function osWorkspaceChildVisibleToPredicate(
	db: DbQueryClient,
	organizationId: string,
	workspaceIdColumn: Parameters<typeof isNull>[0],
	viewer: OsWorkspaceViewer,
): SQL {
	const userIds = [...new Set(viewer.userIds)];
	const workspaceIds = [...new Set(viewer.workspaceIds ?? [])];
	const hidden = db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, organizationId),
				eq(osWorkspaces.visibility, "private"),
				userIds.length === 0
					? undefined
					: or(
							isNull(osWorkspaces.ownerUserId),
							notInArray(osWorkspaces.ownerUserId, userIds),
						),
				workspaceIds.length === 0
					? undefined
					: notInArray(osWorkspaces.id, workspaceIds),
			),
		);
	return or(
		isNull(workspaceIdColumn),
		notInArray(workspaceIdColumn as never, hidden),
	) as SQL;
}

export interface ListOsWorkspacesOptions {
	status?: OsWorkspaceRow["status"];
	limit?: number;
	offset?: number;
}

export interface UpdateOsWorkspacePatch {
	name?: string;
	description?: string | null;
	status?: OsWorkspaceRow["status"];
	visibility?: OsWorkspaceRow["visibility"];
	ownerUserId?: string | null;
}

export async function createOsWorkspace(
	db: DbQueryClient,
	workspace: NewOsWorkspaceRow,
): Promise<OsWorkspaceRow> {
	const [row] = await db.insert(osWorkspaces).values(workspace).returning();
	if (!row) {
		throw new Error("OS workspace insert returned no row");
	}
	return row;
}

export async function getOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams,
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.limit(1);
	return row;
}

export async function getOsWorkspaceByName(
	db: DbQueryClient,
	params: { organizationId: string; name: string },
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.name, params.name),
			),
		)
		.limit(1);
	return row;
}

/** The member's oldest active private workspace: their personal space. */
export async function getPersonalOsWorkspace(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string },
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.visibility, "private"),
				eq(osWorkspaces.ownerUserId, params.ownerUserId),
				eq(osWorkspaces.status, "active"),
			),
		)
		.orderBy(asc(osWorkspaces.createdAt), asc(osWorkspaces.id))
		.limit(1);
	return row;
}

export interface SaveConversationAsOsWorkspaceParams {
	workspace: NewOsWorkspaceRow & { organizationId: string };
	conversationId: string;
	/**
	 * Workspaces the conversation's outputs may currently sit in besides none
	 * (the default chat workspaces). Outputs elsewhere were moved on purpose and
	 * stay where they are.
	 */
	fromWorkspaceIds: readonly string[];
}

export interface SaveConversationAsOsWorkspaceResult {
	workspace: OsWorkspaceRow;
	movedOutputIds: string[];
	linked: boolean;
}

/**
 * Create a workspace from a Home conversation in one batch: insert it, move the
 * outputs that conversation's runs created into it, and link the conversation.
 * The link only claims a conversation that has none.
 */
export async function saveConversationAsOsWorkspace(
	db: DbQueryClient,
	params: SaveConversationAsOsWorkspaceParams,
): Promise<SaveConversationAsOsWorkspaceResult> {
	const { organizationId } = params.workspace;
	const updatedAt = params.workspace.updatedAt ?? new Date().toISOString();
	const createdOutputIds = db
		.select({ outputId: osOutputRevisions.outputId })
		.from(kernelRuntimeRuns)
		.innerJoin(
			osOutputRevisions,
			eq(osOutputRevisions.id, kernelRuntimeRuns.outputRevisionId),
		)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, organizationId),
				eq(kernelRuntimeRuns.conversationId, params.conversationId),
				eq(osOutputRevisions.organizationId, organizationId),
			),
		);
	const [inserted, moved, linked] = await db.batch([
		db.insert(osWorkspaces).values(params.workspace).returning(),
		db
			.update(osOutputs)
			.set({ workspaceId: params.workspace.id, updatedAt })
			.where(
				and(
					eq(osOutputs.organizationId, organizationId),
					// bound-params: a subquery, not a bound list; it binds two values.
					inArray(osOutputs.id, createdOutputIds),
					params.fromWorkspaceIds.length > 0
						? or(
								isNull(osOutputs.workspaceId),
								// bound-params: at most the two default chat workspaces.
								inArray(osOutputs.workspaceId, [...params.fromWorkspaceIds]),
							)
						: isNull(osOutputs.workspaceId),
				),
			)
			.returning({ id: osOutputs.id }),
		db
			.update(kernelConversations)
			.set({ workspaceId: params.workspace.id, updatedAt })
			.where(
				and(
					eq(kernelConversations.organizationId, organizationId),
					eq(kernelConversations.conversationId, params.conversationId),
					isNull(kernelConversations.workspaceId),
					isNull(kernelConversations.deletedAt),
				),
			)
			.returning({ id: kernelConversations.id }),
	]);
	const [workspace] = inserted;
	if (!workspace) throw new Error("OS workspace insert returned no row");
	return {
		workspace,
		movedOutputIds: moved.map((row) => row.id),
		linked: linked.length > 0,
	};
}

export async function listOsWorkspaces(
	db: DbQueryClient,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	options: ListOsWorkspacesOptions = {},
): Promise<OsWorkspaceRow[]> {
	const conditions = [
		eq(osWorkspaces.organizationId, organizationId),
		osWorkspaceVisibleToPredicate(viewer),
	];
	if (options.status) {
		conditions.push(eq(osWorkspaces.status, options.status));
	}
	return db
		.select()
		.from(osWorkspaces)
		.where(and(...conditions))
		.orderBy(asc(osWorkspaces.name), asc(osWorkspaces.id))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500))
		.offset(options.offset ?? 0);
}

export async function updateOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams,
	patch: UpdateOsWorkspacePatch,
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.update(osWorkspaces)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams & { preferenceNamespace?: string },
): Promise<boolean> {
	const deleteWorkspace = db
		.delete(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.returning({ id: osWorkspaces.id });
	if (!params.preferenceNamespace) {
		return (await deleteWorkspace).length > 0;
	}
	const [result] = await db.batch([
		deleteWorkspace,
		db
			.delete(userConfigs)
			.where(
				and(
					eq(userConfigs.namespace, params.preferenceNamespace),
					eq(userConfigs.key, params.workspaceId),
				),
			),
	]);
	return result.length > 0;
}

/**
 * The Workspace a Home turn runs in: the Workspace of the conversation that
 * holds the kernel run, or of the run that delegated it as a child run. Null
 * when the turn is not in a Workspace conversation.
 */
export async function findOsWorkspaceIdForKernelRun(
	db: DbQueryClient,
	params: { organizationId: string; runId: string },
): Promise<string | null> {
	const [row] = await db
		.select({ workspaceId: kernelConversations.workspaceId })
		.from(kernelRuntimeRuns)
		.innerJoin(
			kernelConversations,
			and(
				eq(
					kernelConversations.organizationId,
					kernelRuntimeRuns.organizationId,
				),
				eq(
					kernelConversations.conversationId,
					kernelRuntimeRuns.conversationId,
				),
			),
		)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, params.organizationId),
				or(
					eq(kernelRuntimeRuns.id, params.runId),
					eq(kernelRuntimeRuns.childRunId, params.runId),
				),
				isNotNull(kernelConversations.workspaceId),
				isNull(kernelConversations.deletedAt),
			),
		)
		.limit(1);
	return row?.workspaceId ?? null;
}
