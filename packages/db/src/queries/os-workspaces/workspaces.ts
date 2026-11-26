import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	ne,
	notExists,
	notInArray,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { coreTable } from "../../core-store/client";
import { anyIds, containsText, coreStore } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { getUserConfig, upsertUserConfig } from "../user-configs";
import {
	kernelConversations as d1KernelConversations,
	kernelRuntimeRuns as d1KernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	type NewOsWorkspaceRow,
	type OsWorkspaceRow,
	osWorkspaces as d1OsWorkspaces,
} from "../../schema/os-workspaces";
import {
	osWorkspaceAccessEdges as d1OsWorkspaceAccessEdges,
	osWorkspaceCollaborators as d1OsWorkspaceCollaborators,
	osWorkspaceShareKeys as d1OsWorkspaceShareKeys,
	osWorkspaceShareLinks as d1OsWorkspaceShareLinks,
} from "../../schema/os-collaborators";
import { userConfigs as d1UserConfigs } from "../../schema/user-configs";
import { workspaceOutputIndex as d1WorkspaceOutputIndex } from "../../schema/workspace-feed";

export interface OsWorkspaceScopeParams {
	organizationId: string;
	workspaceId: string;
}

/** Human visibility, or the explicit graph-filtered workspace set for a tedi. */
export interface OsWorkspaceViewer {
	userIds: readonly string[];
	workspaceIds?: readonly string[];
	onlyWorkspaceIds?: readonly string[];
}

export function isOsWorkspaceVisibleTo(
	workspace: Pick<OsWorkspaceRow, "id" | "visibility" | "ownerUserId">,
	viewer: OsWorkspaceViewer,
): boolean {
	if (viewer.onlyWorkspaceIds)
		return viewer.onlyWorkspaceIds.includes(workspace.id);
	if (workspace.visibility !== "private") return true;
	if (viewer.workspaceIds?.includes(workspace.id)) return true;
	return (
		workspace.ownerUserId !== null &&
		viewer.userIds.includes(workspace.ownerUserId)
	);
}

/** SQL twin of `isOsWorkspaceVisibleTo` over `os_workspaces`. */
export function osWorkspaceVisibleToPredicate(
	viewer: OsWorkspaceViewer,
	db?: DbQueryClient,
): SQL {
	const osWorkspaces = db ? coreTable(db, d1OsWorkspaces) : d1OsWorkspaces;
	if (viewer.onlyWorkspaceIds)
		return viewer.onlyWorkspaceIds.length
			? db
				? anyIds(db, osWorkspaces.id, viewer.onlyWorkspaceIds)
				: sql`${osWorkspaces.id} in (select value from json_each(${JSON.stringify(viewer.onlyWorkspaceIds)}))`
			: sql`0 = 1`;
	const userIds = [...new Set(viewer.userIds)];
	const workspaceIds = [...new Set(viewer.workspaceIds ?? [])];
	return or(
		eq(osWorkspaces.visibility, "org"),
		userIds.length
			? db
				? anyIds(db, osWorkspaces.ownerUserId, userIds)
				: inArray(osWorkspaces.ownerUserId, userIds)
			: undefined,
		workspaceIds.length
			? db
				? anyIds(db, osWorkspaces.id, workspaceIds)
				: inArray(osWorkspaces.id, workspaceIds)
			: undefined,
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
	if (viewer.onlyWorkspaceIds)
		return or(
			isNull(workspaceIdColumn),
			viewer.onlyWorkspaceIds.length
				? anyIds(db, workspaceIdColumn as never, viewer.onlyWorkspaceIds)
				: sql`0 = 1`,
		) as SQL;
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
							sql`NOT (${anyIds(db, osWorkspaces.ownerUserId, userIds)})`,
						),
				workspaceIds.length === 0
					? undefined
					: sql`NOT (${anyIds(db, osWorkspaces.id, workspaceIds)})`,
			),
		);
	return or(
		isNull(workspaceIdColumn),
		notInArray(workspaceIdColumn as never, hidden),
	) as SQL;
}

export interface ListOsWorkspacesOptions {
	status?: OsWorkspaceRow["status"];
	/** Case-insensitive substring matched against name and description together. */
	search?: string;
	limit?: number;
	offset?: number;
}

export interface UpdateOsWorkspacePatch {
	name?: string;
	description?: string | null;
	status?: OsWorkspaceRow["status"];
	visibility?: OsWorkspaceRow["visibility"];
	ownerUserId?: string | null;
	iconUrl?: string | null;
	defaultTediId?: string | null;
	machineAccess?: boolean | null;
	highestApprovalMode?: OsWorkspaceRow["highestApprovalMode"];
}

export async function createOsWorkspace(
	db: DbQueryClient,
	workspace: NewOsWorkspaceRow,
): Promise<OsWorkspaceRow> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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

/** Where a member's choice of private workspace for new chats is kept. */
const PERSONAL_CHOICE_KEY = "chat";
const personalChoiceNamespace = (organizationId: string) =>
	`tedix-os-personal-workspace:${organizationId}`;

/**
 * An active private workspace of the member that nobody else can open. One
 * they shared with a person or a tedi, or with a share link that is not
 * revoked, does not qualify: the rule `workspaceOnlyOpenableBy` applies
 * before personal memory is read in it.
 */
function personalWorkspaceWhere(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string },
) {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const osWorkspaceAccessEdges = coreTable(db, d1OsWorkspaceAccessEdges);
	const osWorkspaceShareLinks = coreTable(db, d1OsWorkspaceShareLinks);
	return and(
		eq(osWorkspaces.organizationId, params.organizationId),
		eq(osWorkspaces.visibility, "private"),
		eq(osWorkspaces.ownerUserId, params.ownerUserId),
		eq(osWorkspaces.status, "active"),
		notExists(
			db
				.select({ id: osWorkspaceAccessEdges.id })
				.from(osWorkspaceAccessEdges)
				.where(
					and(
						eq(osWorkspaceAccessEdges.organizationId, params.organizationId),
						eq(osWorkspaceAccessEdges.workspaceId, osWorkspaces.id),
						ne(osWorkspaceAccessEdges.targetUserId, params.ownerUserId),
					),
				),
		),
		notExists(
			db
				.select({ id: osWorkspaceShareLinks.id })
				.from(osWorkspaceShareLinks)
				.where(
					and(
						eq(osWorkspaceShareLinks.organizationId, params.organizationId),
						eq(osWorkspaceShareLinks.workspaceId, osWorkspaces.id),
						isNull(osWorkspaceShareLinks.revokedAt),
					),
				),
		),
	);
}

/** The member's private workspaces that can hold their chats, oldest first. */
export async function listPersonalOsWorkspaces(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string; limit?: number },
): Promise<OsWorkspaceRow[]> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	return db
		.select()
		.from(osWorkspaces)
		.where(personalWorkspaceWhere(db, params))
		.orderBy(asc(osWorkspaces.createdAt), asc(osWorkspaces.id))
		.limit(params.limit ?? 100);
}

async function getQualifyingPersonalOsWorkspace(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string; workspaceId: string },
): Promise<OsWorkspaceRow | undefined> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.id, params.workspaceId),
				personalWorkspaceWhere(db, params),
			),
		)
		.limit(1);
	return row;
}

/**
 * The member's personal space, where their chats run: the private workspace
 * they chose for it while it still qualifies, otherwise their oldest one.
 */
export async function getPersonalOsWorkspace(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string },
): Promise<OsWorkspaceRow | undefined> {
	const choice = await getUserConfig(db, {
		userId: params.ownerUserId,
		namespace: personalChoiceNamespace(params.organizationId),
		key: PERSONAL_CHOICE_KEY,
	});
	const chosenId = choice?.value.workspaceId;
	if (typeof chosenId === "string") {
		const chosen = await getQualifyingPersonalOsWorkspace(db, {
			...params,
			workspaceId: chosenId,
		});
		if (chosen) return chosen;
	}
	const [row] = await listPersonalOsWorkspaces(db, { ...params, limit: 1 });
	return row;
}

/**
 * Makes one of the member's private workspaces the one their chats run in.
 * Returns undefined, and saves nothing, when it does not qualify.
 */
export async function choosePersonalOsWorkspace(
	db: DbQueryClient,
	params: { organizationId: string; ownerUserId: string; workspaceId: string },
): Promise<OsWorkspaceRow | undefined> {
	const workspace = await getQualifyingPersonalOsWorkspace(db, params);
	if (!workspace) return undefined;
	await upsertUserConfig(db, {
		userId: params.ownerUserId,
		namespace: personalChoiceNamespace(params.organizationId),
		key: PERSONAL_CHOICE_KEY,
		value: { workspaceId: workspace.id },
	});
	return workspace;
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
}

/** Creates only the core destination; document placement follows initialization. */
export async function saveConversationAsOsWorkspace(
	db: DbQueryClient,
	params: SaveConversationAsOsWorkspaceParams,
): Promise<SaveConversationAsOsWorkspaceResult> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	await db.batch([
		db
			.insert(osWorkspaces)
			.values(params.workspace)
			.onConflictDoNothing({ target: osWorkspaces.id }),
	]);
	const workspace = await getOsWorkspace(db, {
		organizationId: params.workspace.organizationId,
		workspaceId: params.workspace.id,
	});
	if (
		!workspace ||
		workspace.createdById !== params.workspace.createdById ||
		workspace.createdByKind !== params.workspace.createdByKind ||
		workspace.visibility !== (params.workspace.visibility ?? "org") ||
		workspace.ownerUserId !== (params.workspace.ownerUserId ?? null)
	)
		throw new Error("Workspace save destination conflicts with its owner");
	return { workspace, movedOutputIds: [] };
}

/** The index supplies revision lineage and current location without reading shared documents. */
export async function listConversationWorkspaceDocuments(
	db: DbQueryClient,
	params: {
		organizationId: string;
		conversationId: string;
		fromWorkspaceIds: readonly string[];
	},
) {
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	if (!params.fromWorkspaceIds.length) return [];
	return db
		.selectDistinct({
			outputId: workspaceOutputIndex.outputId,
			workspaceId: workspaceOutputIndex.workspaceId,
		})
		.from(workspaceOutputIndex)
		.innerJoin(
			kernelRuntimeRuns,
			and(
				eq(kernelRuntimeRuns.outputRevisionId, workspaceOutputIndex.revisionId),
				eq(
					kernelRuntimeRuns.organizationId,
					workspaceOutputIndex.organizationId,
				),
			),
		)
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(kernelRuntimeRuns.conversationId, params.conversationId),
				anyIds(db, workspaceOutputIndex.workspaceId, params.fromWorkspaceIds),
			),
		)
		.orderBy(asc(workspaceOutputIndex.outputId));
}

export async function listOsWorkspaces(
	db: DbQueryClient,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	options: ListOsWorkspacesOptions = {},
): Promise<OsWorkspaceRow[]> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const conditions = [
		eq(osWorkspaces.organizationId, organizationId),
		osWorkspaceVisibleToPredicate(viewer, db),
	];
	if (options.status) {
		conditions.push(eq(osWorkspaces.status, options.status));
	}
	const search = options.search?.trim();
	if (search) {
		// Substring search avoids D1's LIKE pattern cap. Fold ASCII only on both
		// stores so Unicode names retain SQLite's existing behavior.
		const text = sql`${osWorkspaces.name} || ' ' || coalesce(${osWorkspaces.description}, '')`;
		const folded =
			coreStore(db) === "postgres"
				? sql`translate(${text}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
				: sql`lower(${text})`;
		conditions.push(
			containsText(
				db,
				folded,
				search.replace(/[A-Z]/g, (char) => char.toLowerCase()),
			),
		);
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
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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

export async function listWorkspaceDocuments(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams,
) {
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	return db
		.selectDistinct({
			outputId: workspaceOutputIndex.outputId,
			workspaceId: workspaceOutputIndex.workspaceId,
		})
		.from(workspaceOutputIndex)
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.workspaceId, params.workspaceId),
			),
		)
		.orderBy(asc(workspaceOutputIndex.outputId));
}

export async function deleteOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams & {
		preferenceNamespace?: string;
		expectedOwnerUserId?: string;
	},
): Promise<boolean> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const osWorkspaceAccessEdges = coreTable(db, d1OsWorkspaceAccessEdges);
	const osWorkspaceCollaborators = coreTable(db, d1OsWorkspaceCollaborators);
	const osWorkspaceShareLinks = coreTable(db, d1OsWorkspaceShareLinks);
	const osWorkspaceShareKeys = coreTable(db, d1OsWorkspaceShareKeys);
	const userConfigs = coreTable(db, d1UserConfigs);
	const workspace = await getOsWorkspace(db, params);
	if (!workspace) return false;
	if (
		params.expectedOwnerUserId !== undefined &&
		(workspace.visibility !== "private" ||
			workspace.ownerUserId !== params.expectedOwnerUserId)
	)
		throw new Error("Workspace owner changed before deletion");
	if (
		workspace.visibility === "private" &&
		(await listWorkspaceDocuments(db, params)).length
	)
		throw new Error("Transfer private documents before deleting the workspace");
	const deleteWorkspace = db
		.delete(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
				params.expectedOwnerUserId !== undefined
					? and(
							eq(osWorkspaces.visibility, "private"),
							eq(osWorkspaces.ownerUserId, params.expectedOwnerUserId),
						)
					: undefined,
			),
		)
		.returning({ id: osWorkspaces.id });
	// Collaborators, their access edges, share links and keys go with the
	// workspace; nothing else references them.
	const scopedLinks = and(
		eq(osWorkspaceShareLinks.organizationId, params.organizationId),
		eq(osWorkspaceShareLinks.workspaceId, params.workspaceId),
	);
	const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
		deleteWorkspace,
		db.delete(osWorkspaceShareKeys).where(
			// bound-params: a subquery, not a bound list (two parameters).
			inArray(
				osWorkspaceShareKeys.linkId,
				db
					.select({ id: osWorkspaceShareLinks.id })
					.from(osWorkspaceShareLinks)
					.where(scopedLinks),
			),
		),
		db.delete(osWorkspaceShareLinks).where(scopedLinks),
		db
			.delete(osWorkspaceAccessEdges)
			.where(
				and(
					eq(osWorkspaceAccessEdges.organizationId, params.organizationId),
					eq(osWorkspaceAccessEdges.workspaceId, params.workspaceId),
				),
			),
		db
			.delete(osWorkspaceCollaborators)
			.where(
				and(
					eq(osWorkspaceCollaborators.organizationId, params.organizationId),
					eq(osWorkspaceCollaborators.workspaceId, params.workspaceId),
				),
			),
	];
	if (params.preferenceNamespace)
		statements.push(
			db
				.delete(userConfigs)
				.where(
					and(
						eq(userConfigs.namespace, params.preferenceNamespace),
						eq(userConfigs.key, params.workspaceId),
					),
				),
		);
	const [result] = (await db.batch(statements)) as [{ id: string }[]];
	return result.length > 0;
}

/** Chats opened from inside a Workspace keep it; other Home chats stay in Home. */
const WORKSPACE_OPENED_CHAT_PREFIX = "home:os:";

/**
 * The Home conversation of a kernel run, or of the run that delegated it as a
 * child run. `workspaceId` is set only for a chat opened from inside a
 * Workspace: a document saved from a Home chat ties that document, not the
 * chat, to a Workspace.
 */
export async function findHomeTurnForKernelRun(
	db: DbQueryClient,
	params: { organizationId: string; runId: string },
): Promise<{ conversationId: string; workspaceId: string | null } | null> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const kernelConversations = coreTable(db, d1KernelConversations);
	const [row] = await db
		.select({
			workspaceId: kernelConversations.workspaceId,
			conversationId: kernelConversations.conversationId,
		})
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
				isNull(kernelConversations.deletedAt),
			),
		)
		.limit(1);
	if (!row) return null;
	return {
		conversationId: row.conversationId,
		workspaceId: row.conversationId.startsWith(WORKSPACE_OPENED_CHAT_PREFIX)
			? row.workspaceId
			: null,
	};
}

/** No visibility filter: organization offboarding includes every private workspace. */
export async function listOrganizationWorkspaceDeletionCandidates(
	db: DbQueryClient,
	organizationId: string,
	afterId?: string,
) {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	return db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, organizationId),
				afterId === undefined
					? undefined
					: sql`${osWorkspaces.id} > ${afterId}`,
			),
		)
		.orderBy(asc(osWorkspaces.id))
		.limit(100);
}

/** Called only after the workspace object has acknowledged permanent deletion. */
export async function deleteWorkspaceDocumentIndex(
	db: DbQueryClient,
	scope: OsWorkspaceScopeParams,
) {
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	await db.batch([
		db
			.delete(workspaceOutputIndex)
			.where(
				and(
					eq(workspaceOutputIndex.organizationId, scope.organizationId),
					eq(workspaceOutputIndex.workspaceId, scope.workspaceId),
				),
			),
	]);
}
