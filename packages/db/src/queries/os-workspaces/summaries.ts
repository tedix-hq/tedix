/**
 * Workspace summary rows (`os_workspace_summaries`).
 *
 * The workspace store publishes one summary snapshot per workspace to the
 * core through the automation-events queue; the consumer applies snapshots
 * idempotently in revision order (newest wins), so redelivery and
 * out-of-order messages settle on the freshest published state.
 * Cross-workspace readers — the org-wide Work board's project links, admin
 * and search workspace listings, and workspace usage views — read these rows
 * instead of fanning out to the workspace-scoped source tables.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import {
	kernelConversations as d1KernelConversations,
	kernelRuntimeRuns as d1KernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	type OsWorkspaceProjectRow,
	type OsWorkspaceSummaryRow,
	osWorkspaceProjects as d1OsWorkspaceProjects,
	osWorkspaceSummaries as d1OsWorkspaceSummaries,
	osWorkspaces as d1OsWorkspaces,
} from "../../schema/os-workspaces";

/** Workspace activity rollup for admin and usage views. */
export interface OsWorkspaceUsageSummary {
	conversationCount: number;
	messageCount: number;
	runCount: number;
}

/** Workspace run-status rollup for admin and search listings. */
export interface OsWorkspaceRunStatusSummary {
	activeRunCount: number;
	latestRun: {
		id: string;
		status: string;
		updatedAt: string;
	} | null;
}

/** One Work project link as the Work board needs it (active rows only). */
export type OsWorkspaceWorkLink = Pick<
	OsWorkspaceProjectRow,
	| "id"
	| "organizationId"
	| "workspaceId"
	| "projectId"
	| "status"
	| "createdByKind"
	| "createdById"
	| "createdAt"
	| "updatedAt"
	| "removedAt"
>;

export interface OsWorkspaceSummaryPayload {
	usage: OsWorkspaceUsageSummary;
	runStatus: OsWorkspaceRunStatusSummary;
	workLinks: OsWorkspaceWorkLink[];
}

export interface OsWorkspaceSummaryScopeParams {
	organizationId: string;
	workspaceId: string;
}

/**
 * The snapshot a queue message carries, before JSON encoding.
 * `revision` is the publisher-minted ordering key (epoch ms); `publishedAt`
 * is the publisher wall clock so applied lag is measurable.
 */
export interface OsWorkspaceSummarySnapshot extends OsWorkspaceSummaryScopeParams {
	revision: number;
	publishedAt: string;
	payload: OsWorkspaceSummaryPayload;
}

export function parseOsWorkspaceSummaryPayload(
	row: OsWorkspaceSummaryRow,
): OsWorkspaceSummaryPayload {
	const fallback: OsWorkspaceSummaryPayload = {
		usage: { conversationCount: 0, messageCount: 0, runCount: 0 },
		runStatus: { activeRunCount: 0, latestRun: null },
		workLinks: [],
	};
	try {
		return {
			usage: JSON.parse(row.usage) as OsWorkspaceUsageSummary,
			runStatus: JSON.parse(row.runStatus) as OsWorkspaceRunStatusSummary,
			workLinks: JSON.parse(row.workLinks) as OsWorkspaceWorkLink[],
		};
	} catch {
		// A payload that cannot parse is worse than an empty rollup: report the
		// row as empty rather than failing the cross-workspace read on it.
		return fallback;
	}
}

/** Marks a usage rollup the workspace object reported from its own chat. */
const OBJECT_USAGE_SOURCE = '"source":"workspace_object"';
function objectOwnsUsage(db: DbQueryClient) {
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	return sql`${osWorkspaceSummaries.usage} LIKE ${`%${OBJECT_USAGE_SOURCE}%`}`;
}

/**
 * Apply one published snapshot, newest revision wins. Returns the applied
 * row, or `undefined` when the stored row is already at a newer or equal
 * revision — making redelivery and out-of-order arrival no-ops.
 */
export async function applyOsWorkspaceSummary(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams & {
		revision: number;
		usage: string;
		runStatus: string;
		workLinks: string;
		publishedAt: string;
		appliedAt: string;
	},
): Promise<OsWorkspaceSummaryRow | undefined> {
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	const [row] = await db
		.insert(osWorkspaceSummaries)
		.values({
			workspaceId: params.workspaceId,
			organizationId: params.organizationId,
			revision: params.revision,
			usage: params.usage,
			runStatus: params.runStatus,
			workLinks: params.workLinks,
			publishedAt: params.publishedAt,
			appliedAt: params.appliedAt,
			createdAt: params.appliedAt,
			updatedAt: params.appliedAt,
		})
		.onConflictDoUpdate({
			target: osWorkspaceSummaries.workspaceId,
			set: {
				organizationId: params.organizationId,
				revision: params.revision,
				// Chat counts a workspace object reported stay: the core's own
				// count reads kernel rows, which that workspace's chat never writes.
				usage: sql`CASE WHEN ${objectOwnsUsage(db)} THEN ${osWorkspaceSummaries.usage} ELSE excluded.usage END`,
				runStatus: sql`CASE WHEN ${objectOwnsUsage(db)} THEN ${osWorkspaceSummaries.runStatus} ELSE excluded.run_status END`,
				workLinks: params.workLinks,
				publishedAt: params.publishedAt,
				appliedAt: params.appliedAt,
				updatedAt: params.appliedAt,
			},
			setWhere: sql`excluded.revision > ${osWorkspaceSummaries.revision}`,
		})
		.returning();
	return row;
}

export async function getOsWorkspaceSummary(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams,
): Promise<OsWorkspaceSummaryRow | undefined> {
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	const [row] = await db
		.select()
		.from(osWorkspaceSummaries)
		.where(
			and(
				eq(osWorkspaceSummaries.organizationId, params.organizationId),
				eq(osWorkspaceSummaries.workspaceId, params.workspaceId),
			),
		)
		.limit(1);
	return row;
}

/** Every summary row in the org — the cross-workspace read. */
export async function listOsWorkspaceSummaries(
	db: DbQueryClient,
	organizationId: string,
): Promise<OsWorkspaceSummaryRow[]> {
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	return db
		.select()
		.from(osWorkspaceSummaries)
		.where(eq(osWorkspaceSummaries.organizationId, organizationId));
}

export async function deleteOsWorkspaceSummary(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams,
): Promise<void> {
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	await db
		.delete(osWorkspaceSummaries)
		.where(
			and(
				eq(osWorkspaceSummaries.organizationId, params.organizationId),
				eq(osWorkspaceSummaries.workspaceId, params.workspaceId),
			),
		);
}

function listActiveOsWorkspaceWorkLinks(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams,
): Promise<OsWorkspaceWorkLink[]> {
	const osWorkspaceProjects = coreTable(db, d1OsWorkspaceProjects);
	return db
		.select({
			id: osWorkspaceProjects.id,
			organizationId: osWorkspaceProjects.organizationId,
			workspaceId: osWorkspaceProjects.workspaceId,
			projectId: osWorkspaceProjects.projectId,
			status: osWorkspaceProjects.status,
			createdByKind: osWorkspaceProjects.createdByKind,
			createdById: osWorkspaceProjects.createdById,
			createdAt: osWorkspaceProjects.createdAt,
			updatedAt: osWorkspaceProjects.updatedAt,
			removedAt: osWorkspaceProjects.removedAt,
		})
		.from(osWorkspaceProjects)
		.where(
			and(
				eq(osWorkspaceProjects.organizationId, params.organizationId),
				eq(osWorkspaceProjects.workspaceId, params.workspaceId),
				eq(osWorkspaceProjects.status, "active"),
			),
		);
}

/**
 * Store the chat counts a workspace object reports from its own conversations
 * and turns. The object serializes its reports and writes them directly, so
 * they need no ordering key: `revision` and the Work links stay with the core
 * publisher, and a queued core snapshot is never dropped because of a report.
 * Returns false when the workspace has no core row to attach a summary to.
 */
export async function applyOsWorkspaceObjectUsage(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams & {
		usage: OsWorkspaceUsageSummary;
		runStatus: OsWorkspaceRunStatusSummary;
		publishedAt: string;
	},
): Promise<boolean> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const osWorkspaceSummaries = coreTable(db, d1OsWorkspaceSummaries);
	const usage = `{${OBJECT_USAGE_SOURCE},${JSON.stringify(params.usage).slice(1)}`;
	const reported = {
		usage,
		runStatus: JSON.stringify(params.runStatus),
		publishedAt: params.publishedAt,
		appliedAt: params.publishedAt,
		updatedAt: params.publishedAt,
	};
	const updated = await db
		.update(osWorkspaceSummaries)
		.set(reported)
		.where(
			and(
				eq(osWorkspaceSummaries.organizationId, params.organizationId),
				eq(osWorkspaceSummaries.workspaceId, params.workspaceId),
			),
		)
		.returning({ workspaceId: osWorkspaceSummaries.workspaceId });
	if (updated.length > 0) return true;
	const [workspace] = await db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.limit(1);
	if (!workspace) return false;
	// First row for this workspace: read the Work links so Work-board readers
	// of the summary never see an empty list the core did not publish.
	const revision = Date.now();
	const workLinks = await listActiveOsWorkspaceWorkLinks(db, params);
	await db
		.insert(osWorkspaceSummaries)
		.values({
			workspaceId: params.workspaceId,
			organizationId: params.organizationId,
			revision,
			workLinks: JSON.stringify(workLinks),
			createdAt: params.publishedAt,
			...reported,
		})
		.onConflictDoUpdate({
			target: osWorkspaceSummaries.workspaceId,
			set: reported,
			setWhere: eq(osWorkspaceSummaries.organizationId, params.organizationId),
		});
	return true;
}

/**
 * Re-derive one workspace's full summary payload from the source tables:
 * active Work project links, the kernel run rollup over workspace
 * conversations, and the usage rollup. The publisher calls this so every
 * message carries a complete, self-contained snapshot.
 */
export async function computeOsWorkspaceSummary(
	db: DbQueryClient,
	params: OsWorkspaceSummaryScopeParams,
): Promise<OsWorkspaceSummaryPayload> {
	const kernelConversations = coreTable(db, d1KernelConversations);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const links = await listActiveOsWorkspaceWorkLinks(db, params);

	const [latestRun] = await db
		.select({
			id: kernelRuntimeRuns.id,
			status: kernelRuntimeRuns.status,
			updatedAt: kernelRuntimeRuns.updatedAt,
		})
		.from(kernelRuntimeRuns)
		.innerJoin(
			kernelConversations,
			and(
				eq(
					kernelRuntimeRuns.organizationId,
					kernelConversations.organizationId,
				),
				eq(
					kernelRuntimeRuns.conversationId,
					kernelConversations.conversationId,
				),
			),
		)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, params.organizationId),
				eq(kernelConversations.workspaceId, params.workspaceId),
				isNull(kernelConversations.deletedAt),
			),
		)
		.orderBy(desc(kernelRuntimeRuns.updatedAt), desc(kernelRuntimeRuns.id))
		.limit(1);
	const [activity] = await db
		.select({
			conversations:
				sql<number>`coalesce(count(${kernelConversations.id}), 0)`.as(
					"conversations",
				),
			messages:
				sql<number>`coalesce(sum(${kernelConversations.messageCount}), 0)`.as(
					"messages",
				),
		})
		.from(kernelConversations)
		.where(
			and(
				eq(kernelConversations.organizationId, params.organizationId),
				eq(kernelConversations.workspaceId, params.workspaceId),
				isNull(kernelConversations.deletedAt),
			),
		);
	const [runCounts] = await db
		.select({
			total: sql<number>`coalesce(count(${kernelRuntimeRuns.id}), 0)`.as(
				"total",
			),
			active:
				sql<number>`coalesce(sum(case when ${kernelRuntimeRuns.status} in ('queued', 'running', 'requires_approval') then 1 else 0 end), 0)`.as(
					"active",
				),
		})
		.from(kernelRuntimeRuns)
		.innerJoin(
			kernelConversations,
			and(
				eq(
					kernelRuntimeRuns.organizationId,
					kernelConversations.organizationId,
				),
				eq(
					kernelRuntimeRuns.conversationId,
					kernelConversations.conversationId,
				),
			),
		)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, params.organizationId),
				eq(kernelConversations.workspaceId, params.workspaceId),
				isNull(kernelConversations.deletedAt),
			),
		);

	return {
		usage: {
			conversationCount: Number(activity?.conversations ?? 0),
			messageCount: Number(activity?.messages ?? 0),
			runCount: Number(runCounts?.total ?? 0),
		},
		runStatus: {
			activeRunCount: Number(runCounts?.active ?? 0),
			latestRun: latestRun ?? null,
		},
		workLinks: links,
	};
}
