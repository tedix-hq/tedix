import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead } from "../core-store/dialect";
import { tediRuntimeEvents as schemaTediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediSessionStates as schemaTediSessionStates } from "../schema/tedi-sessions";

export type TediSessionState = typeof schemaTediSessionStates.$inferSelect;

export async function getTediSessionState(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKey: string;
	},
): Promise<TediSessionState | null> {
	const tediSessionStates = coreTable(db, schemaTediSessionStates);
	const [row] = await db
		.select()
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.userId, input.userId),
				eq(tediSessionStates.sessionKey, input.sessionKey),
			),
		)
		.limit(1);
	return row ?? null;
}

function derivedTitle(value: string | undefined): string | null {
	const title = value?.trim();
	return title &&
		!/^(conversation|chat|session|thread|new|new chat|untitled|untitled chat)$/i.test(
			title,
		)
		? title
		: null;
}

export async function upsertTediSessionState(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKey: string;
		title?: string | null;
		derivedTitle?: string;
		pinned?: boolean;
		deleted?: boolean;
		lastSeenAt?: number | null;
	},
): Promise<TediSessionState | null> {
	const tediSessionStates = coreTable(db, schemaTediSessionStates);
	const now = new Date().toISOString();
	const hasTitle = input.title !== undefined;
	const normalizedDerivedTitle = derivedTitle(input.derivedTitle);
	const hasDerivedTitle = !hasTitle && normalizedDerivedTitle !== null;
	const hasPinned = input.pinned !== undefined;
	const hasDeleted = input.deleted !== undefined;
	const hasLastSeenAt = input.lastSeenAt !== undefined;
	const updateValues: {
		deletedAt?: string | null;
		lastSeenAt?: number | null;
		pinnedAt?: string | null;
		title?: SQL | string | null;
		updatedAt: string;
	} = { updatedAt: now };
	if (hasTitle) updateValues.title = input.title ?? null;
	else if (hasDerivedTitle) {
		updateValues.title = sql`
			case
				when ${tediSessionStates.title} is null
					or trim(${tediSessionStates.title}) = ''
					or lower(trim(${tediSessionStates.title})) in ('conversation', 'chat', 'session', 'thread', 'new', 'new chat', 'untitled', 'untitled chat')
				then ${normalizedDerivedTitle}
				else ${tediSessionStates.title}
			end
		`;
	}
	if (hasPinned) updateValues.pinnedAt = input.pinned ? now : null;
	if (hasDeleted) updateValues.deletedAt = input.deleted ? now : null;
	if (hasLastSeenAt) updateValues.lastSeenAt = input.lastSeenAt ?? null;

	const rows = await db
		.insert(tediSessionStates)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			tediId: input.tediId,
			userId: input.userId,
			sessionKey: input.sessionKey,
			title: hasTitle ? input.title : normalizedDerivedTitle,
			pinnedAt: input.pinned ? now : null,
			deletedAt: input.deleted ? now : null,
			lastSeenAt: hasLastSeenAt ? input.lastSeenAt : null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				tediSessionStates.organizationId,
				tediSessionStates.tediId,
				tediSessionStates.userId,
				tediSessionStates.sessionKey,
			],
			set: updateValues,
		})
		.returning();
	return rows[0] ?? getTediSessionState(db, input);
}

export async function listTediSessionStates(
	db: DbClient,
	input: { organizationId: string; tediId: string; userId: string },
): Promise<TediSessionState[]> {
	const tediSessionStates = coreTable(db, schemaTediSessionStates);
	return db
		.select()
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.userId, input.userId),
			),
		)
		.orderBy(
			sql`${tediSessionStates.pinnedAt} DESC NULLS LAST`,
			desc(tediSessionStates.updatedAt),
		);
}

export async function listTediConversationActivity(
	db: DbClient,
	input: { organizationId: string; tediId: string },
): Promise<Array<{ id: string; lastActivityIso: string | null }>> {
	const tediRuntimeEvents = coreTable(db, schemaTediRuntimeEvents);
	const rows = await db
		.select({
			conversationId: tediRuntimeEvents.conversationId,
			lastAt: sql<string>`max(${tediRuntimeEvents.createdAt})`,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.organizationId, input.organizationId),
			),
		)
		.groupBy(tediRuntimeEvents.conversationId);
	return rows
		.filter(
			(row): row is { conversationId: string; lastAt: string } =>
				typeof row.conversationId === "string" && row.conversationId.length > 0,
		)
		.map((row) => ({ id: row.conversationId, lastActivityIso: row.lastAt }));
}

export async function bulkSoftDeleteTediSessionStates(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKeys: string[];
	},
): Promise<number> {
	const tediSessionStates = coreTable(db, schemaTediSessionStates);
	const now = new Date().toISOString();
	const keys = [...new Set(input.sessionKeys)];
	if (!keys.length) return 0;
	const entries = JSON.stringify(
		keys.map((sessionKey) => ({ id: crypto.randomUUID(), sessionKey })),
	);
	const source =
		coreStore(db) === "postgres"
			? sql`jsonb_array_elements(${entries}::text::jsonb) AS entry(value)`
			: sql`json_each(${entries}) AS entry`;
	await db
		.insert(tediSessionStates)
		.select(
			db
				.select({
					id: sql<string>`${jsonRead(db, sql`entry.value`, ["id"])}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					tediId: sql<string>`${input.tediId}`.as("tedi_id"),
					userId: sql<string>`${input.userId}`.as("user_id"),
					sessionKey:
						sql<string>`${jsonRead(db, sql`entry.value`, ["sessionKey"])}`.as(
							"session_key",
						),
					title: sql<string | null>`null`.as("title"),
					pinnedAt: sql<string | null>`null`.as("pinned_at"),
					deletedAt: sql<string>`${now}`.as("deleted_at"),
					lastSeenAt: sql<number | null>`null`.as("last_seen_at"),
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(source)
				.where(sql`true`),
		)
		.onConflictDoUpdate({
			target: [
				tediSessionStates.organizationId,
				tediSessionStates.tediId,
				tediSessionStates.userId,
				tediSessionStates.sessionKey,
			],
			set: { deletedAt: now, pinnedAt: null, updatedAt: now },
		});
	return input.sessionKeys.length;
}
