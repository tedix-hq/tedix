/**
 * What a person has and has not seen in a workspace.
 *
 * Storage is one small row per person per workspace (a read marker in
 * `user_configs`), never a row per message. What is new is read from the
 * workspace activity feed: every row above the marker's sequence number. All
 * reads here are bounded by an index and a limit.
 */

import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
} from "../schema/workspace-feed";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import { upsertUserConfig } from "./user-configs";

/**
 * Everything at or below `floor` is read. All chat is also read up to `chat`,
 * one conversation up to its entry in `chats`, and one file up to its entry
 * in `files`.
 */
export interface WorkspaceReadMarker {
	floor: number;
	chat: number;
	chats: Record<string, number>;
	files: Record<string, number>;
}

export interface WorkspaceUnreadScope {
	organizationId: string;
	userId: string;
}

/** Most workspaces one person's unread summary looks at. */
export const WORKSPACE_READ_MARKER_LIMIT = 200;
/** Most files, and most conversations, a marker remembers above its floor. */
export const WORKSPACE_READ_MARKER_ENTRY_LIMIT = 200;
/** Most feed rows one unread read looks at per workspace. */
export const WORKSPACE_UNREAD_ROW_LIMIT = 300;

const markerNamespace = (organizationId: string) =>
	`os.unread:${organizationId}`;

function integer(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: 0;
}

function positions(value: unknown, above: number): Record<string, number> {
	const result: Record<string, number> = {};
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [id, seq] of Object.entries(value)) {
			const read = integer(seq);
			if (read > above) result[id] = read;
		}
	}
	return result;
}

/** Keep the newest entries; the oldest ones fall back to the floor. */
function newest(
	entries: Record<string, number>,
	above: number,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(entries)
			.filter(([, seq]) => seq > above)
			.sort((a, b) => b[1] - a[1])
			.slice(0, WORKSPACE_READ_MARKER_ENTRY_LIMIT),
	);
}

/** Stored JSON is data from an earlier write; anything unexpected reads as zero. */
export function parseWorkspaceReadMarker(value: unknown): WorkspaceReadMarker {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const floor = integer(record.floor);
	const chat = Math.max(integer(record.chat), floor);
	return {
		floor,
		chat,
		chats: positions(record.chats, chat),
		files: positions(record.files, floor),
	};
}

export async function listWorkspaceReadMarkers(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
): Promise<Map<string, WorkspaceReadMarker>> {
	const rows = await db
		.select({ key: userConfigs.key, value: userConfigs.value })
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, markerNamespace(scope.organizationId)),
			),
		)
		.orderBy(asc(userConfigs.key))
		.limit(WORKSPACE_READ_MARKER_LIMIT);
	return new Map(
		rows.map((row) => [row.key, parseWorkspaceReadMarker(row.value)]),
	);
}

export async function getWorkspaceReadMarker(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
): Promise<WorkspaceReadMarker | null> {
	const [row] = await db
		.select({ value: userConfigs.value })
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, markerNamespace(scope.organizationId)),
				eq(userConfigs.key, workspaceId),
			),
		)
		.limit(1);
	return row ? parseWorkspaceReadMarker(row.value) : null;
}

export async function saveWorkspaceReadMarker(
	db: DbQueryClient,
	scope: WorkspaceUnreadScope,
	workspaceId: string,
	marker: WorkspaceReadMarker,
): Promise<void> {
	const chat = Math.max(marker.chat, marker.floor);
	await upsertUserConfig(db, {
		userId: scope.userId,
		namespace: markerNamespace(scope.organizationId),
		key: workspaceId,
		value: {
			floor: marker.floor,
			chat,
			chats: newest(marker.chats, chat),
			files: newest(marker.files, marker.floor),
		},
	});
}

/** The newest feed sequence number of each workspace that has one. */
export async function listWorkspaceFeedPositions(
	db: DbQueryClient,
	organizationId: string,
	workspaceIds: readonly string[],
): Promise<Map<string, number>> {
	const positions = new Map<string, number>();
	for (const chunk of chunkForBoundParams([...new Set(workspaceIds)], 50)) {
		const rows = await db
			.select({
				workspaceId: workspaceFeedCursors.workspaceId,
				lastSeq: workspaceFeedCursors.lastSeq,
			})
			.from(workspaceFeedCursors)
			.where(
				and(
					// bound-params: chunked by chunkForBoundParams
					inArray(workspaceFeedCursors.workspaceId, chunk),
					eq(workspaceFeedCursors.organizationId, organizationId),
				),
			);
		for (const row of rows) positions.set(row.workspaceId, row.lastSeq);
	}
	return positions;
}

export interface WorkspaceUnreadFeedRow {
	seq: number;
	kind: "output" | "run";
	entityId: string;
	actorKind: "user" | "tedi" | "external_agent" | "service";
	actorId: string;
	title: string | null;
	occurredAt: string;
	/** JSON `WorkspaceChangeSummary` of a run row; null for a file row. */
	runSummary: string | null;
}

/**
 * Feed rows above `afterSeq` that someone other than the reader wrote, newest
 * first. Only file and run rows can be unread; memory and artifact rows are
 * left out in SQL.
 */
function buildWorkspaceUnreadFeedStatement(
	db: DbQueryClient,
	params: {
		organizationId: string;
		workspaceId: string;
		afterSeq: number;
		/** Every id the reader is recorded under; their own rows are never unread. */
		readerIds: readonly string[];
		limit?: number;
	},
) {
	const readerIds = [...new Set(params.readerIds)].slice(0, 4);
	return db
		.select({
			seq: sql<number>`${workspaceActivity.seq}`.as("unread_seq"),
			kind: sql<"output" | "run">`${workspaceActivity.kind}`.as("unread_kind"),
			entityId: sql<string>`${workspaceActivity.entityId}`.as(
				"unread_entity_id",
			),
			actorKind: sql<
				WorkspaceUnreadFeedRow["actorKind"]
			>`${workspaceActivity.actorKind}`.as("unread_actor_kind"),
			actorId: sql<string>`${workspaceActivity.actorId}`.as("unread_actor_id"),
			title: sql<string | null>`${workspaceActivity.title}`.as("unread_title"),
			occurredAt: sql<string>`${workspaceActivity.occurredAt}`.as(
				"unread_occurred_at",
			),
			runSummary: sql<string | null>`${workspaceFeedLedger.summary}`.as(
				"unread_run_summary",
			),
		})
		.from(workspaceActivity)
		.leftJoin(
			workspaceFeedLedger,
			and(
				eq(workspaceFeedLedger.id, workspaceActivity.id),
				eq(workspaceActivity.kind, "run"),
			),
		)
		.where(
			and(
				eq(workspaceActivity.workspaceId, params.workspaceId),
				gt(workspaceActivity.seq, params.afterSeq),
				eq(workspaceActivity.organizationId, params.organizationId),
				// bound-params: the two feed kinds that can be unread
				inArray(workspaceActivity.kind, ["output", "run"]),
				readerIds.length
					? // bound-params: at most four ids of one person
						notInArray(workspaceActivity.actorId, readerIds)
					: undefined,
			),
		)
		.orderBy(desc(workspaceActivity.seq))
		.limit(
			Math.min(
				Math.max(params.limit ?? WORKSPACE_UNREAD_ROW_LIMIT, 1),
				WORKSPACE_UNREAD_ROW_LIMIT,
			),
		);
}

export type WorkspaceUnreadFeedParams = Parameters<
	typeof buildWorkspaceUnreadFeedStatement
>[1];

export async function listWorkspaceUnreadFeed(
	db: DbQueryClient,
	params: WorkspaceUnreadFeedParams,
): Promise<WorkspaceUnreadFeedRow[]> {
	return buildWorkspaceUnreadFeedStatement(db, params);
}

/** Several workspaces in one round trip; results keep the order of `params`. */
export async function listWorkspaceUnreadFeeds(
	db: DbQueryClient,
	params: readonly WorkspaceUnreadFeedParams[],
): Promise<WorkspaceUnreadFeedRow[][]> {
	if (params.length === 0) return [];
	return db.batch(
		batchNonEmpty(
			params.map((entry) => buildWorkspaceUnreadFeedStatement(db, entry)),
		),
	) as Promise<WorkspaceUnreadFeedRow[][]>;
}
